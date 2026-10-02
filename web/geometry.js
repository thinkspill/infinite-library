// The library's shape and how people move through it: one module, imported by the page (./geometry.js) and by the
// server (src/body.ts and src/world-core.ts import it), so the walkway the page lets you walk on is the one the server checks.
// Plain JavaScript like babel.js, because the page can't import TypeScript.
//
// World frame, the one players' positions are reported in: metres, z up. This gallery's wall is at x = -G, its
// railing at x = 0, the shaft runs from x = 0 to x = SHAFT (the far railing), and y runs along the gallery. Each
// metre of wall, unit u covers y in [u, u + 1). z is height above your floor's walkway.
// The page builds its meshes in a wall-local frame (x measured from the wall, 0..G); convert with x_world = x_wall - G.
import { SHELVES, SLOTS } from './babel.js';

// ---------------------------------------------------------------- the gallery
export const G = 7;                   // walkway depth: wall at x = -G, railing at x = 0
export const SHAFT = 30;              // shaft width; the far railing is at x = SHAFT
export const SEG = 20;                // the page's streaming segment length along the gallery
export const FLOOR_PITCH = 3.2;       // floor to floor

// ---------------------------------------------------------------- shelves and books
// A shelf unit is UNIT_D deep against the wall and UNIT_H tall; SHELVES shelves of SLOTS books each (babel.js).
export const UNIT_D = 0.3, UNIT_H = 2.4;
export const SHELF_FACE = -G + UNIT_D;  // world x of the spines
export const SHELF_PITCH = 0.38;        // shelf s's board is at z = s * SHELF_PITCH
export const SHELF_BASE = 0.02;         // board thickness: a book stands on it, so its foot is at shelfZ(s)
export const BOOK_W = 0.03, BOOK_H = 0.30;
export const SLOT0 = 0.02;              // the first book starts this far into its unit (the unit's side panel)
export const shelfZ = shelf => shelf * SHELF_PITCH + SHELF_BASE;              // foot of the books on a shelf
export const slotY = (unit, slot) => unit + SLOT0 + (slot + 0.5) * BOOK_W;    // middle of a spine, along the gallery
// The book whose spine is at height z above the walkway, y along the gallery (clamped onto the unit's shelves).
export function bookAt(y, z) {
  const unit = Math.floor(y);
  return {
    unit,
    shelf: Math.max(0, Math.min(SHELVES - 1, Math.floor((z - SHELF_BASE) / SHELF_PITCH))),
    slot: Math.max(0, Math.min(SLOTS - 1, Math.floor((y - unit - SLOT0) / BOOK_W))),
  };
}

// ---------------------------------------------------------------- stairs
// Stairs rise toward +y from floor f at y0 = 40n + 10 to floor f+1 at y0 + STAIR_LEN, one flight right above another.
export const STAIR_PERIOD = 40, STAIR_OFF = 10, STAIR_LEN = 4.8, STAIR_RISE = FLOOR_PITCH, HOLE0 = 0;
// the stair band, in world x: along the railing (at x = 0), so the shelves on the wall never break
export const STAIR_X0 = -2.3, STAIR_X1 = -0.08;
const mod = (a, n) => ((a % n) + n) % n;
export const stairLocal = y => mod(y - STAIR_OFF, STAIR_PERIOD);            // 0..STAIR_LEN while on a stair's run
export const onStairRun = y => stairLocal(y) <= STAIR_LEN;
// The page draws the gallery in SEG-metre segments built from one template, so a flight must sit at the same place in
// every segment that has one and never straddle two: say so here, where the stairs are defined, rather than in the page.
if (STAIR_PERIOD % SEG !== 0 || mod(STAIR_OFF, SEG) + STAIR_LEN > SEG) throw new Error('geometry.js: stairs must fit whole segments');
export const STAIR_IN_SEG = mod(STAIR_OFF, SEG);                                // where a flight starts within its segment
export const segmentHasStair = j => mod(j * SEG + STAIR_IN_SEG - STAIR_OFF, STAIR_PERIOD) === 0;
export const onStairHole = y => { const l = stairLocal(y); return l >= HOLE0 && l <= STAIR_LEN; };
export const inStairBand = x => x > STAIR_X0 && x < STAIR_X1;
export function nearestStairFoot(y) {
  return Math.round((y - STAIR_OFF) / STAIR_PERIOD) * STAIR_PERIOD + STAIR_OFF;
}
// Within a metre of a stair's run: where a floor change by stairs can happen.
export function nearStair(y) {
  const l = stairLocal(y);
  return l <= STAIR_LEN + 1 || l >= STAIR_PERIOD - 1;
}

// ---------------------------------------------------------------- the shaft
// The far gallery is drawn as this one turned half a turn about the middle of the shaft, segment by segment. It
// holds the other side's books: a player who steers past the midpoint while falling crosses to that side, and
// is carried into its frame at this point. It is its own inverse.
export function acrossShaft(x, y) {
  const j = Math.floor(y / SEG);
  return { x: SHAFT - x, y: (2 * j + 1) * SEG - y };
}

// Crossing the shaft in a fall: once a fall. The far gallery is drawn segment by segment, each the mirror of its own
// SEG metres (acrossShaft), so what you see across the shaft is exactly where a crossing puts you. Crossing back in the
// next segment would not undo it (over and back again would carry a faller 2 * SEG along), so after one crossing the
// far side's middle is as far as a fall lets you steer; back on a walkway (x <= 0) the fall is over.
export const MIDLINE = SHAFT / 2;
// How far a faller at (ox, oy) must have travelled to be reported at (nx, ny) on the other side. The page crossed in
// whichever segment it was in at that moment: its own (exact, since acrossShaft keeps distances within a segment), or
// a neighbour it walked into first, measured as the run to the shared edge and on from that edge's image, x and y
// together (never shorter than any real path). The shortest of the three.
export function crossingDistance(ox, oy, nx, ny) {
  const j = Math.floor(oy / SEG), dx = nx - (SHAFT - ox);
  const here = Math.hypot(dx, ny - ((2 * j + 1) * SEG - oy));
  const below = Math.hypot(dx, (oy - j * SEG) + Math.abs(ny - (j - 1) * SEG));
  const above = Math.hypot(dx, ((j + 1) * SEG - oy) + Math.abs(ny - (j + 2) * SEG));
  return Math.min(here, below, above);
}

// ---------------------------------------------------------------- bodies and movement
export const WALK = 1.5, RUN = 4.2;   // m/s
export const TERMINAL = 40;           // m/s, falling
export const GRAV = 20, JUMP = 5.0;   // m/s², and a jump's take-off speed
export const EYE = 1.7;               // eye height above the feet
export const BODY_R = 0.3;            // how close a body comes to the shelves and the railing
export const REACH = 3;               // metres from the eye to a book you can take down
export const FALL_FLOORS_PER_S = TERMINAL / FLOOR_PITCH;
// Dead reckoning: a person's last reported course is carried forward for at most this long, by the server (src/body.ts),
// by the page for the figures of others, and by the page's own guess of what the server thinks (web/session.js).
export const EXTRAPOLATE_S = 3;
// Falling past a floor, you can get back over its railing only where your feet clear the rail and the slab edge.
export const RAIL_TOP = 1.15, SLAB_BOT = -0.34;
export const railClear = z => (z > RAIL_TOP || z < SLAB_BOT) && z > RAIL_TOP - FLOOR_PITCH;   // z runs -2.2..2.2 about a floor
// Where a standing body's x may be on a walkway: off the shelves, behind the railing.
export const clampWalkway = x => Math.max(SHELF_FACE + BODY_R, Math.min(-BODY_R, x));

// Height of the walking surface under (x, y) no higher than z + step, or -Infinity (the shaft, a stair's opening).
export function groundAt(x, y, z, step) {
  let best = -Infinity;
  const c = v => { if (v <= z + step && v > best) best = v; };
  if (x <= 0) {
    if (inStairBand(x) && onStairRun(y)) { const lo = stairLocal(y) / STAIR_LEN * STAIR_RISE; c(lo); c(lo + FLOOR_PITCH); c(lo - FLOOR_PITCH); }
    if (!(inStairBand(x) && onStairHole(y))) { c(0); c(FLOOR_PITCH); c(-FLOOR_PITCH); }
  }
  return best;
}
// A horizontal move from (ox, oy) toward (nx, ny) with feet at height z: where the walls, the railings and the
// stairs' side rails let it end. Returns [x, y].
export function resolve(nx, ny, ox, oy, z) {
  if (ox > 0) {
    if (nx >= BODY_R || !railClear(z)) return [Math.max(BODY_R, Math.min(SHAFT - BODY_R, nx)), ny];
    return [clampWalkway(nx), ny];                                                     // over a railing onto a walkway
  }
  nx = Math.max(nx, SHELF_FACE + BODY_R);
  if ((onStairRun(ny) || onStairRun(oy)) && ((ox < STAIR_X0) !== (nx < STAIR_X0))) nx = ox;   // stair rails block sideways entry
  nx = Math.min(nx, -BODY_R);                                                          // the shaft railing
  return [nx, ny];
}
