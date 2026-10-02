// How a person's body moves through the library, frame by frame: one pure module the page calls each frame with what
// the player is trying to do, and scripts/check-walk.ts drives at 60 fps to check the server (src/body.ts judgeMove)
// accepts what it produces. No DOM, no Three.js, no clock, no globals: a body and an intent in, a new body and a list
// of what happened out. The page turns keys, touch and auto-walk into an intent, and the events into messages.
// Plain JavaScript like geometry.js, whose shape and speeds it moves through.
//
// A body (world frame, geometry.js): { x, y, z, vx, vy, vz, yaw, grounded, floor, side, fallen, dist }
//   z: feet above this floor's walkway (kept in -2.2..2.2: past that the floor number changes instead)
//   vx, vy: the horizontal velocity of the last step (what the page reports, for the server to carry you forward)
//   fallen: floors passed falling fast; dist: metres walked along the gallery (the HUD's counts)
// An intent: { forward, strafe, run, jump, still }
//   forward, strafe: -1..1 each (back/forward, left/right; a diagonal is normalised); run: running pace;
//   jump: wants to jump (taken only when standing); still: holding a book (no walking, no jumping, but gravity)
// Events, in order: { type: 'blocked' }        a wall, railing or stair rail stopped part of the move
//                   { type: 'crossed', side }   carried across the shaft's midpoint into the other gallery (yaw turns
//                   too); once a fall (body.crossed), after which the far side's middle holds you (geometry.js MIDLINE)
//                   { type: 'jumped' }
//                   { type: 'airborne' }        left the ground (a jump, a step off, going over the railing)
//                   { type: 'landed', speed }   back on the ground, speed m/s downward at impact
//                   { type: 'floor', dir }      the floor number changed by dir (+1 up, -1 down): stairs, or falling
//                   { type: 'climbedOver' }     (climbOver only) over the railing into the shaft
import {
  SHAFT, FLOOR_PITCH, WALK, RUN, GRAV, TERMINAL, JUMP, inStairBand, onStairRun, acrossShaft, MIDLINE, groundAt, resolve,
} from './geometry.js';

export const MAX_DT = 0.05;           // a longer frame (a stall, a background tab) is stepped as this long
export const Z_WRAP = 2.2;            // past this far above or below a walkway you are on the next floor's terms
export const FAST_FALL = 12;          // m/s: falling faster than this past a floor counts it as fallen
export const STEP_UP = 0.45, AIR_STEP = 0.05, SNAP_DOWN = 0.6;   // how far ground is found standing / in the air, and stuck to going down

export const STILL = Object.freeze({ forward: 0, strafe: 0, run: false, jump: false, still: false });

// One frame: the body after dt seconds of trying to do intent, and what happened on the way.
export function walk(body, intent, dt) {
  const b = { ...body }, events = [], i = { ...STILL, ...intent };
  dt = Math.min(dt, MAX_DT);
  const wasGrounded = b.grounded;
  if (i.still) b.vx = b.vy = 0;
  else {
    const speed = i.run ? RUN : WALK, f = i.forward, s = i.strafe;
    const len = Math.hypot(f, s) || 1, cy = Math.cos(b.yaw), sy = Math.sin(b.yaw);
    const wx = b.x + (f * cy + s * sy) / len * speed * dt, wy = b.y + (f * sy - s * cy) / len * speed * dt;
    const [nx, ny] = resolve(wx, wy, b.x, b.y, b.z);
    if (nx !== wx || ny !== wy) events.push({ type: 'blocked' });
    if (b.grounded && b.x <= 0) b.dist += Math.abs(ny - b.y);
    b.vx = (nx - b.x) / dt; b.vy = (ny - b.y) / dt;
    b.x = nx; b.y = ny;
    if (b.x > MIDLINE) {
      if (!b.crossed) {   // past the middle of the shaft: the far gallery's frame (the one drawn across from you), its own side
        const a = acrossShaft(b.x, b.y);
        b.x = a.x; b.y = a.y; b.yaw += Math.PI; b.side ^= 1; b.vx = -b.vx; b.vy = -b.vy; b.crossed = true;
        events.push({ type: 'crossed', side: b.side });
      } else { b.x = MIDLINE; b.vx = 0; events.push({ type: 'blocked' }); }   // once a fall: the far side's middle holds you
    }
    if (b.x <= 0) b.crossed = false;   // on a walkway: this fall, if any, is over
    if (i.jump && b.grounded) { b.vz = JUMP; b.grounded = false; events.push({ type: 'jumped' }); }
  }
  b.vz = Math.max(b.vz - GRAV * dt, -TERMINAL);
  let nz = b.z + b.vz * dt;
  const g = groundAt(b.x, b.y, b.z, b.grounded ? STEP_UP : AIR_STEP);
  let impact = 0;
  if (g > -Infinity && nz <= g) { impact = -b.vz; nz = g; b.vz = 0; b.grounded = true; }
  else if (b.grounded && g > -Infinity && b.z - g < SNAP_DOWN && b.vz <= 0) { nz = g; b.vz = 0; }   // down a stair
  else b.grounded = false;
  b.z = nz;
  if (wasGrounded && !b.grounded) events.push({ type: 'airborne' });
  if (!wasGrounded && b.grounded) events.push({ type: 'landed', speed: impact });
  if (b.z < -Z_WRAP) { b.z += FLOOR_PITCH; b.floor -= 1; if (b.vz < -FAST_FALL) b.fallen += 1; events.push({ type: 'floor', dir: -1 }); }
  else if (b.z > Z_WRAP) { b.z -= FLOOR_PITCH; b.floor += 1; events.push({ type: 'floor', dir: 1 }); }
  return { body: b, events };
}

// Over the railing: from standing on the walkway within a metre of it, facing the shaft, and not from the stairs.
export const facingShaft = body => Math.cos(body.yaw) > 0.35;
export const canClimb = body => body.grounded && body.x > -1.0 && body.x <= 0 && facingShaft(body) && !(inStairBand(body.x) && onStairRun(body.y));
// The body just over the railing (on its way down), or null when it can't climb from where it is.
export function climbOver(body) {
  if (!canClimb(body)) return null;
  return { body: { ...body, x: 0.7, vz: 1.5, grounded: false }, events: [{ type: 'climbedOver' }, { type: 'airborne' }] };
}
