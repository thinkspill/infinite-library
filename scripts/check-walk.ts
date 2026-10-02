// Checks web/walk.js, how a person's body moves frame by frame, against the server that judges it (src/body.ts
// judgeMove): walk.js is driven at 60 fps with simulated keys, its positions reported the way the page's Net does
// (on a change of course, floor, side or fall, when the server's guess drifts, else every 2 s; never more than one
// per 0.1 s), and every report of an honest trajectory must be accepted. Also: the step is the page's old step()
// exactly (a copy of it is kept below as the reference), and floors, stairs, walls and the railing behave.
// No server, no browser: node scripts/check-walk.ts
import * as W from '../web/walk.js';
import * as Geo from '../web/geometry.js';
import * as Proto from '../web/protocol.js';
import { moveDue, moveOf } from '../web/session.js';
import * as B from '../src/body.ts';
import * as R from '../src/rules.ts';
import type { Body } from '../src/body.ts';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

type Intent = { forward?: number; strafe?: number; run?: boolean; jump?: boolean; still?: boolean };
type WBody = { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; grounded: boolean; floor: number; side: number; fallen: number; dist: number };
type Ev = { type: string; side?: number; dir?: number; speed?: number };
const body = (o: Partial<WBody> = {}): WBody =>
  ({ x: R.SPAWN.x, y: R.SPAWN.y, z: 0, vx: 0, vy: 0, vz: 0, yaw: R.SPAWN.yaw, pitch: 0, grounded: true, floor: 0, side: 0, fallen: 0, dist: 0, ...o });
// settle onto the ground (a body placed on a stair, say): a few frames of standing still
const settle = (b: WBody) => { for (let k = 0; k < 10; k++) b = W.walk(b, {}, 1 / 60).body as WBody; return b; };

// ---------------------------------------------------------------- the page's old step(), kept as the reference
// (web/short-stay-library.html before walk.js, with keys/touch/autoWalk/reading turned into the same intent)
function legacyStep(P: WBody, i: Intent, dt: number) {
  const reading = !!i.still, S = Geo.SHAFT;
  dt = Math.min(dt, 0.05);
  if (reading) P.vx = P.vy = 0;
  if (!reading) {
    const speed = i.run ? Geo.RUN : Geo.WALK, f = i.forward ?? 0, s = i.strafe ?? 0;
    const len = Math.hypot(f, s) || 1, cy = Math.cos(P.yaw), sy = Math.sin(P.yaw);
    let nx = P.x + (f * cy + s * sy) / len * speed * dt, ny = P.y + (f * sy - s * cy) / len * speed * dt;
    [nx, ny] = Geo.resolve(nx, ny, P.x, P.y, P.z);
    if (P.grounded && P.x <= 0) P.dist += Math.abs(ny - P.y);
    P.vx = (nx - P.x) / dt; P.vy = (ny - P.y) / dt;
    P.x = nx; P.y = ny;
    // changed on purpose (2026-10-02): one crossing a fall, then the far side's middle holds you (crossing back in
    // another segment carried a zig-zagging faller 40 m a crossing); otherwise this is the page's step() as was
    if (P.x > S / 2) {
      if (!P.crossed) { const a = Geo.acrossShaft(P.x, P.y); P.x = a.x; P.y = a.y; P.yaw += Math.PI; P.side ^= 1; P.vx = -P.vx; P.vy = -P.vy; P.crossed = true; }
      else { P.x = S / 2; P.vx = 0; }
    }
    if (P.x <= 0) P.crossed = false;
    if (i.jump && P.grounded) { P.vz = Geo.JUMP; P.grounded = false; }
  }
  P.vz = Math.max(P.vz - Geo.GRAV * dt, -Geo.TERMINAL);
  let nz = P.z + P.vz * dt;
  const g = Geo.groundAt(P.x, P.y, P.z, P.grounded ? 0.45 : 0.05);
  if (g > -Infinity && nz <= g) { nz = g; P.vz = 0; P.grounded = true; }
  else if (P.grounded && g > -Infinity && P.z - g < 0.6 && P.vz <= 0) { nz = g; P.vz = 0; }
  else P.grounded = false;
  P.z = nz;
  if (P.z < -2.2) { P.z += Geo.FLOOR_PITCH; P.floor -= 1; if (P.vz < -12) P.fallen += 1; }
  else if (P.z > 2.2) { P.z -= Geo.FLOOR_PITCH; P.floor += 1; }
}
function legacyClimb(P: WBody) {
  const canClimb = P.grounded && P.x > -1.0 && P.x <= 0 && Math.cos(P.yaw) > 0.35 && !(Geo.inStairBand(P.x) && Geo.onStairRun(P.y));
  if (canClimb) { P.x = 0.7; P.vz = 1.5; P.grounded = false; }
  return canClimb;
}

// ---------------------------------------------------------------- the page and the server, simulated
// A driver says, each frame, what the player does: an intent, a new yaw (turning), or going over the railing.
type Act = Intent & { yaw?: number; climb?: boolean };
type Driver = (t: number, b: WBody) => Act;
interface Run { b: WBody; events: (Ev & { t: number; from?: number })[]; reports: number; refused: string[]; server: Body; floors: Set<number> }
const T0 = 1_790_000_000_000;
// fps: frame rate; latency: one-way delay of a report, s; jitter: up to this much more, random (reports stay in order)
function simulate(start: WBody, drive: Driver, seconds: number, { fps = 60, latency = 0.05, jitter = 0, seed = 1 } = {}): Run {
  let b = { ...start }, t = 0, rnd = seed, lastArrive = 0, sendT = 0;
  const random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const server: Body = { kind: 'human', x: b.x, y: b.y, floor: b.floor, yaw: b.yaw, side: b.side, fall: null, lastMoveAt: T0 - 1000 };
  const run: Run = { b, events: [], reports: 0, refused: [], server, floors: new Set([b.floor]) };
  let L: (ReturnType<typeof Proto.move> & { at: number }) | null = null;
  const frame = 1 / fps;
  while (t < seconds) {
    t += frame;
    const a = drive(t, b);
    if (a.yaw !== undefined) b = { ...b, yaw: a.yaw };
    if (a.climb) { const c = W.climbOver(b); if (c) { b = c.body as WBody; for (const e of c.events) run.events.push({ ...e, t }); } }
    const r = W.walk(b, a, frame), from = b.y;
    b = r.body as WBody; for (const e of r.events) run.events.push({ ...(e as Ev), t, from });
    run.floors.add(b.floor);
    // Net.tick, as the page has it
    sendT += frame; if (sendT < 0.1) continue; sendT = 0;
    const now = t * 1000, vx = Math.abs(b.vx) < 0.05 ? 0 : b.vx, vy = Math.abs(b.vy) < 0.05 ? 0 : b.vy, reading = !!a.still;
    let due = !L || L.floor !== b.floor || L.side !== b.side || L.reading !== reading || (L.x > 0) !== (b.x > 0) || (!!(L.vx || L.vy) !== !!(vx || vy));
    if (!due && L) {
      const dt = Math.min(3, (now - L.at) / 1000), err = Math.hypot(L.x + (L.vx ?? 0) * dt - b.x, L.y + (L.vy ?? 0) * dt - b.y);
      const turn = Math.abs(Math.atan2(Math.sin(b.yaw - L.yaw), Math.cos(b.yaw - L.yaw)));
      due = err > 0.5 || Math.hypot(vx - (L.vx ?? 0), vy - (L.vy ?? 0)) > 0.4 || (turn > 0.35 && now - L.at > 500) || now - L.at > (vx || vy ? 2000 : 5000);
    }
    if (!due) continue;
    const m = Proto.move({ x: b.x, y: b.y, floor: b.floor, side: b.side, yaw: b.yaw, vx, vy, reading });
    L = { ...m, at: now };
    // the server, as World.onMove has it
    const arrive = lastArrive = Math.max(lastArrive, t + latency + random() * jitter);
    const at = T0 + Math.round(arrive * 1000), v = B.judgeMove(server, m as unknown as Record<string, unknown>, at);
    run.reports++;
    if (!v) { run.refused.push(`t ${t.toFixed(2)}: ignored as malformed`); continue; }
    if (!v.ok) {
      run.refused.push(`t ${t.toFixed(2)} s: ${v.correct.reason}: from (x ${server.x.toFixed(2)}, y ${server.y.toFixed(2)}, floor ${server.floor}, side ${server.side}) ` +
        `to (x ${m.x}, y ${m.y}, floor ${m.floor}, side ${m.side}) after ${((at - (server.lastMoveAt ?? at)) / 1000).toFixed(3)} s`);
      server.lastMoveAt = at;
      continue;
    }
    server.lastMoveAt = at;
    Object.assign(server, v.to);
  }
  run.b = b;
  return run;
}
const has = (r: Run, type: string, f: (e: Ev) => boolean = () => true) => r.events.some(e => e.type === type && f(e));
const accepted = (r: Run, what: string) => {
  check(r.refused.length === 0 && r.reports > 0, `${what}: the server accepts all ${r.reports} reports${r.refused.length ? `; refused ${r.refused.length}:\n       ${r.refused.slice(0, 5).join('\n       ')}` : ''}`);
};

console.log('The step is the page\'s old step()');
{
  // random inputs, and some long frames, from places that matter: the walkway, the stairs, the railing, mid-shaft
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const starts = [body(), body({ x: -1.2, y: 9 }), body({ x: -0.4, yaw: 0 }), body({ x: 8, grounded: false, vz: -20 }), body({ x: 14.9, y: 19.95, yaw: 0.1, grounded: false }), body({ x: -6.5, y: -3 })];
  let differ = 0, frames = 0, climbs = 0;
  for (const s of starts) {
    let a = { ...s }, w = { ...s } as WBody;
    for (let k = 0; k < 3000; k++) {
      if (k % 30 === 0) { const yaw = (rnd() - 0.5) * 7; a.yaw = yaw; w = { ...w, yaw }; }
      if (rnd() < 0.01) { const c = W.climbOver(w); const ok = legacyClimb(a); if (!!c !== ok) differ++; if (c) { w = c.body as WBody; climbs++; } }
      const i: Intent = { forward: Math.round(rnd() * 2 - 1), strafe: Math.round(rnd() * 2 - 1), run: rnd() < 0.5, jump: rnd() < 0.05, still: rnd() < 0.05 };
      const dt = rnd() < 0.02 ? 0.2 : 1 / 60;
      legacyStep(a, i, dt); w = W.walk(w, i, dt).body as WBody; frames++;
      if (JSON.stringify(a) !== JSON.stringify(w)) { differ++; a = { ...w }; }
    }
  }
  check(differ === 0, `walk.js matches the old step() bit for bit over ${frames} random frames from six places, ${climbs} climbs over the railing (${differ} differ)`);
  const b0 = body(), copy = JSON.stringify(b0); W.walk(b0, { forward: 1, run: true, jump: true }, 1 / 60); W.climbOver(body({ x: -0.5, yaw: 0 }));
  check(JSON.stringify(b0) === copy, 'it is pure: the body passed in is not changed');
}

console.log('\nFloors, stairs, walls, the railing');
{
  // floor wrap at the slab: a fall from just above -2.2 crosses into the floor below, z back up by a floor
  let r = W.walk(body({ x: 5, z: -2.19, vz: -30, grounded: false }), {}, 1 / 60);
  check(r.body.floor === -1 && near(r.body.z, -2.19 - 30.333333 / 60 + 3.2, 1e-3) && has({ events: r.events } as Run, 'floor', e => e.dir === -1) && r.body.fallen === 1,
    `falling past z -2.2 is the floor below, at z ${r.body.z.toFixed(3)} (and counts as fallen at speed)`);
  r = W.walk(body({ x: 5, z: -2.19, vz: -5, grounded: false }), {}, 1 / 60);
  check(r.body.floor === -1 && r.body.fallen === 0, 'a slow drop past a floor does not count as fallen');
  // stairs: ground rises 3.2 m over the 4.8 m run from y 10, in the band along the railing
  let b = settle(body({ x: -1.2, y: 9.5 })), heights: number[] = [];
  for (let k = 0; k < 60 * 6; k++) { b = W.walk(b, { forward: 1 }, 1 / 60).body as WBody; if (Math.abs(b.y - 12.4) < 0.013) heights.push(b.z + b.floor * 3.2); }
  check(b.floor === 1 && near(b.z, 0, 1e-9) && b.grounded, `walking up a flight from y 9.5 for 6 s ends on floor 1 at z 0 (floor ${b.floor}, y ${b.y.toFixed(2)})`);
  check(heights.length > 0 && heights.every(h => near(h, 1.6, 0.05)), `halfway up (y 12.4) the feet are 1.6 m up (${heights.map(h => h.toFixed(3))})`);
  for (const [y, z] of [[10, 0], [11.2, 0.8], [13.6, 2.4], [14.8, 3.2], [16, 0]]) {
    const g = Geo.groundAt(-1.2, y, z, 0.45);
    check(near(g, z, 1e-9), `stair ground at y ${y} is ${z} (${g})`);
  }
  // walls: walking into the shelves stops at SHELF_FACE + BODY_R, with 'blocked'
  b = body({ x: -6, yaw: Math.PI }); let blocked = false;
  for (let k = 0; k < 120; k++) { const s = W.walk(b, { forward: 1, run: true }, 1 / 60); b = s.body as WBody; blocked ||= s.events.some(e => e.type === 'blocked'); }
  check(near(b.x, Geo.SHELF_FACE + Geo.BODY_R) && blocked, `the shelves stop you at x ${b.x.toFixed(2)}, and say so`);
  b = body({ x: -1, yaw: 0 });
  for (let k = 0; k < 120; k++) b = W.walk(b, { forward: 1, run: true }, 1 / 60).body as WBody;
  check(near(b.x, -Geo.BODY_R) && b.grounded && b.floor === 0, `walking at the railing stops you at x ${b.x} (only climbing takes you over)`);
  b = body({ x: -3, y: 12, yaw: 0 });
  for (let k = 0; k < 60; k++) b = W.walk(b, { forward: 1 }, 1 / 60).body as WBody;
  check(b.x < Geo.STAIR_X0, `a stair's side rail stops you stepping onto the flight from the side (x ${b.x.toFixed(2)})`);
  // the railing: only standing within a metre of it, facing the shaft, off the stairs
  check(W.climbOver(body({ x: -0.5, yaw: 0 }))?.body.x === 0.7, 'over the railing from x -0.5 facing the shaft: to x 0.7, rising');
  check(W.climbOver(body({ x: -2, yaw: 0 })) === null && W.climbOver(body({ x: -0.5, yaw: Math.PI / 2 })) === null
    && W.climbOver(body({ x: -0.5, y: 12, yaw: 0 })) === null && W.climbOver(body({ x: -0.5, yaw: 0, grounded: false })) === null,
    'not from 2 m back, not facing along the gallery, not from a stair, not mid-air');
  // crossing: past the middle of the shaft into the far frame
  r = W.walk(body({ x: 14.99, y: 4, yaw: 0, grounded: false, vz: -40 }), { forward: 1 }, 1 / 60);
  const a = Geo.acrossShaft(14.99 + 1.5 / 60, 4);
  check(r.body.side === 1 && near(r.body.x, a.x) && near(r.body.y, a.y) && near(r.body.yaw, Math.PI) && r.body.vx < 0 && r.events.some(e => e.type === 'crossed' && e.side === 1),
    `steering past x 15 crosses to the west side, y mirrored (${r.body.x.toFixed(3)}, ${r.body.y.toFixed(3)}), yaw turned, still heading on (vx ${r.body.vx.toFixed(2)})`);
  r = W.walk(body({ grounded: true }), { forward: 1, jump: true }, 1 / 60);
  check(r.body.vz > 0 && !r.body.grounded && r.events.map(e => e.type).join() === 'jumped,airborne', `a jump takes off (${r.events.map(e => e.type)})`);
  r = W.walk(body({ grounded: true }), { forward: 1, jump: true, still: true }, 1 / 60);
  check(r.body.grounded && r.body.vx === 0 && r.body.y === R.SPAWN.y, 'holding a book: no walking, no jumping');
}

console.log('\nHonest trajectories, reported as the page reports them, judged by the server');
{
  const r = simulate(body(), () => ({ forward: 1 }), 60);
  accepted(r, `walking along the gallery for 60 s (${(r.b.y - R.SPAWN.y).toFixed(1)} m)`);
  check(near(r.b.y - R.SPAWN.y, 90, 0.1) && r.b.floor === 0, 'and covers 90 m at walking pace on floor 0');
}
{
  const r = simulate(body(), () => ({ forward: 1, run: true }), 60);
  accepted(r, `running along the gallery for 60 s (${(r.b.y - R.SPAWN.y).toFixed(1)} m)`);
  const r2 = simulate(body(), t => ({ forward: t % 7 < 4 ? 1 : 0, strafe: t % 5 < 1 ? 1 : 0, run: t % 3 < 1.5, yaw: Math.PI / 2 + 0.6 * Math.sin(t) }), 60);
  accepted(r2, 'walking, running, stopping, strafing and weaving for 60 s');
  const r3 = simulate(body(), () => ({ forward: -1, run: true }), 60, { fps: 30 });
  accepted(r3, 'running backwards at 30 fps for 60 s');
}
{
  const up = simulate(body({ x: -1.2, y: 8 }), () => ({ forward: 1 }), 8);
  accepted(up, `up a flight (floors ${[...up.floors]})`);
  check(up.b.floor === 1 && has(up, 'floor', e => e.dir === 1), 'and arrives on floor 1');
  // up three flights: along the stair, on along the gallery to the next foot, 40 m on
  const three = simulate(body({ x: -1.2, y: 8 }), () => ({ forward: 1, run: true }), 30);
  accepted(three, `running up the gallery and four flights (floors ${[...three.floors]})`);
  check(three.b.floor === 4, `four floors up in 126 m: flights at y 10, 50, 90, 130 (${three.b.floor})`);
  const down = simulate(settle(body({ x: -1.2, y: 17, floor: 1, yaw: -Math.PI / 2 })), () => ({ forward: 1 }), 8);
  accepted(down, `down a flight (floors ${[...down.floors]})`);
  check(down.b.floor === 0 && has(down, 'floor', e => e.dir === -1) && down.b.grounded, 'and arrives on floor 0, standing');
  const downRun = simulate(settle(body({ x: -1.2, y: 17, floor: 1, yaw: -Math.PI / 2 })), () => ({ forward: 1, run: true }), 30);
  accepted(downRun, `running down the gallery and its flights for 30 s (to floor ${downRun.b.floor})`);
}
{
  const fall = simulate(body({ x: -0.5, yaw: 0 }), t => ({ climb: t < 0.05 }), 10);
  accepted(fall, `over the railing and falling for 10 s (${fall.b.floor} floors)`);
  check(has(fall, 'climbedOver') && fall.b.floor < -100 && fall.b.x === 0.7 && fall.b.fallen > 100, `down ${-fall.b.floor} floors, ${fall.b.fallen} counted as fallen`);
  // walk to the railing first, turn to it, climb
  const walkUp = simulate(body(), t => t < 1 ? { forward: 1 } : t < 3 ? { yaw: 0, forward: 1 } : { climb: true }, 10);
  accepted(walkUp, 'walking to the railing, turning, going over and falling');
  check(walkUp.b.x > 0 && walkUp.b.floor < -50, `falling (x ${walkUp.b.x}, floor ${walkUp.b.floor})`);
}
{
  // steer across the shaft while falling, and land on the far side's walkway
  const across = simulate(body({ x: -0.5, yaw: 0 }), t => ({ climb: t < 0.05, forward: 1, run: true }), 15);
  accepted(across, `running across the shaft while falling, landing on the far side (floor ${across.b.floor})`);
  check(across.b.side === 1 && has(across, 'crossed', e => e.side === 1) && has(across, 'landed') && across.b.grounded && across.b.x <= 0,
    `on the west side, standing on its walkway at x ${across.b.x.toFixed(2)}, y ${across.b.y.toFixed(2)} (mirrored from ${R.SPAWN.y}: ${Geo.acrossShaft(10, R.SPAWN.y).y})`);
  const walking = simulate(body({ x: -0.5, yaw: 0 }), t => ({ climb: t < 0.05, forward: 1 }), 25);
  accepted(walking, `walking across the shaft while falling, landing on the far side (side ${walking.b.side}, x ${walking.b.x.toFixed(2)})`);
  check(walking.b.side === 1 && walking.b.grounded, 'and lands');
}
{
  // falling across the shaft near a segment's end (y 20): drifting along y too (running diagonally, ~14.3 m of drift
  // by the middle), so the crossing is right at it, either side of it, either way round
  const drift = 14.3;
  for (const strafe of [-1, 1]) for (const d of [-0.4, -0.1, -0.02, 0.02, 0.1, 0.4]) {
    const y0 = 20 + strafe * drift + d;
    const r = simulate(body({ x: -0.5, y: y0, yaw: 0 }), t => ({ climb: t < 0.05, forward: 1, strafe, run: true }), 15);
    const c = r.events.find(e => e.type === 'crossed');
    accepted(r, `falling across the shaft drifting ${strafe > 0 ? '-y' : '+y'}, crossing at y ${c?.from?.toFixed(2)} (segment end 20), ending at y ${r.b.y.toFixed(1)} on side ${r.b.side}`);
  }
  // and falling straight down beside a segment's end, steering along it
  const along = simulate(body({ x: -0.5, y: 19.5, yaw: 0 }), t => t < 0.05 ? { climb: true } : { yaw: Math.PI / 2, forward: 1 }, 10);
  accepted(along, `falling along the shaft past y 20 (y ${along.b.y.toFixed(1)})`);
}
{
  const jumps = simulate(body(), t => ({ forward: 1, run: t % 4 < 2, jump: t % 1.3 < 0.05 }), 20);
  accepted(jumps, `jumping while walking and running for 20 s (${jumps.events.filter(e => e.type === 'jumped').length} jumps)`);
  const stairJumps = simulate(body({ x: -1.2, y: 8 }), t => ({ forward: 1, jump: t % 0.9 < 0.05 }), 8);
  accepted(stairJumps, `jumping up a flight (floor ${stairJumps.b.floor})`);
  const reading = simulate(body(), t => ({ forward: 1, still: t > 3 && t < 6 }), 10);
  accepted(reading, 'walking, stopping to read, walking on');
}

console.log('\nWith a slow or jittery connection');
{
  const runs: [string, Run][] = [
    ['running 60 s, 300 ms latency', simulate(body(), () => ({ forward: 1, run: true }), 60, { latency: 0.3 })],
    ['running up the stairs, 0-250 ms jitter', simulate(body({ x: -1.2, y: 8 }), () => ({ forward: 1, run: true }), 30, { jitter: 0.25, seed: 3 })],
    ['across the shaft, 0-250 ms jitter', simulate(body({ x: -0.5, yaw: 0 }), t => ({ climb: t < 0.05, forward: 1, run: true }), 15, { jitter: 0.25, seed: 5 })],
  ];
  for (const [what, r] of runs) accepted(r, what);
  // a fall at terminal velocity is reported every floor (≈ every 0.1 s); a report held up and the next one not
  // shrink the server's gap to its 0.1 s floor while the body fell for longer
  let worst = '', refusedSeeds = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = simulate(body({ x: -0.5, yaw: 0 }), t => ({ climb: t < 0.05 }), 10, { jitter: 0.25, seed });
    if (r.refused.length) { refusedSeeds++; worst ||= r.refused[0]; }
  }
  check(refusedSeeds === 0, `a 10 s fall, 0-250 ms jitter, 20 runs: none refused${refusedSeeds ? ` (refused in ${refusedSeeds}: ${worst})` : ''}`);
}

console.log('\nZig-zagging across the shaft: once a fall');
{
  // the page's own physics: fall at the shaft's middle just past a segment edge, step across, sidestep 10 cm into the
  // next segment, and try to step back. Crossing back in another segment would carry the faller 40 m; once a fall,
  // the far side's middle holds them instead.
  let body: any = { x: 14.9, y: 20.05, z: 0, yaw: 0, pitch: 0, vz: -5, vx: 0, vy: 0, grounded: false, floor: 100, side: 0, fallen: 0, dist: 0, crossed: false };
  let crossings = 0, held = 0;
  for (let n = 0; n < 200; n++) {
    const r = W.walk(body, { forward: 1, strafe: 0, run: true }, 0.02); body = r.body;
    if (r.events.some((e: any) => e.type === 'crossed')) { crossings++; body = { ...body, y: (Math.floor(body.y / Geo.SEG) + 1) * Geo.SEG + 0.05, yaw: 0 }; }
    if (body.x === Geo.MIDLINE) held++;
  }
  check(crossings === 1 && held > 0 && body.x <= Geo.MIDLINE && body.side === 1, `one crossing, then the far side's middle holds you (${crossings} crossing, held ${held} frames)`);
  const srv: any = { kind: 'human', x: 15.1, y: 40.05, floor: 100, side: 1, yaw: 0, fall: null, lastMoveAt: 0, vx: 0, vy: 0, crossed: true };
  const back = Geo.acrossShaft(15.1, 40.05);
  check(B.judgeMove(srv, Proto.move({ x: back.x, y: back.y, floor: 100, yaw: 0, side: 0 }), 250)?.ok === false, 'and a second crossing reported anyway is refused');
  const landed = W.walk({ ...body, x: -1, y: 61, z: 0, vz: 0, grounded: true }, { forward: 0, strafe: 0, run: false }, 0.02).body;
  check(landed.crossed === false, 'standing on a walkway ends the fall: the next fall may cross again');
}

console.log('\nOver the railing, run across, out over the far railing');
{
  // the page's own run, reported as the session reports (every 0.1 s, and at once into or out of the shaft, across it
  // or a floor): over the railing, run on across the shaft, out over a far railing mid-air and down onto that walkway
  let body: any = { x: -0.31, y: 3.25, z: 0, yaw: 0, pitch: 0, vz: 0, vx: 0, vy: 0, grounded: true, floor: 0, side: 0, fallen: 0, dist: 0, crossed: false };
  const srv: any = { kind: 'human', x: -0.31, y: 3.25, floor: 0, side: 0, yaw: 0, fall: null, lastMoveAt: 0, vx: 0, vy: 0, crossed: false };
  body = W.climbOver(body)!.body;
  let t = 0, last: any = null, sendT = 0, refused = 0;
  for (let i = 0; i < 60 * 12; i++) {
    body = W.walk(body, { forward: 1, strafe: 0, run: true }, 1 / 60).body; t += 1000 / 60;
    const changed = !last || (last.x > 0) !== (body.x > 0) || last.side !== body.side || last.floor !== body.floor;
    sendT += 1 / 60; if (sendT < 0.1 && !changed) continue; sendT = 0;
    if (!moveDue(body, last, t)) continue;
    const m = moveOf(body); last = { ...m, at: t };
    const v = B.judgeMove(srv, m, t); if (!v) continue;
    srv.lastMoveAt = t;
    if (!v.ok) { refused++; break; }
    Object.assign(srv, v.to);
  }
  check(refused === 0 && body.side === 1 && body.x <= 0, `every report accepted, ending on the far walkway (${refused} refused, floor ${body.floor}, x ${body.x.toFixed(2)})`);
}

console.log(failures ? `\n${failures} failed, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failures ? 1 : 0);
