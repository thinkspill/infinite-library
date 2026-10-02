// Checks web/geometry.js, the library's shape and movement, which the page and the server share: the server imports it
// directly (src/rules.ts, the server's own numbers, copies nothing from it, babel.js or protocol.js), the page imports
// it rather than keeping its own copy, its stair and shaft predicates hold
// at known points, the page's reach is inside the server's, and walking the page's way never trips the server's
// speed cap. No server needed: node scripts/check-geometry.ts
import { readFileSync } from 'node:fs';
import * as Geo from '../web/geometry.js';
import * as Babel from '../web/babel.js';
import * as Proto from '../web/protocol.js';
import * as R from '../src/rules.ts';

let failed = 0;
// the property tests below draw from a seeded generator, so a failure can be replayed: SEED=n node scripts/check-geometry.ts
const SEED = Number(process.env.SEED ?? 1);
const rnd = (() => { let a = SEED >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const check = (cond: unknown, what: string) => { if (!cond) { console.error('FAIL', what); failed++; } else console.log('ok  ', what); };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- one source
{
  // rules.ts holds only the server's own numbers: nothing it exports shadows a name from the shared modules, so there
  // is no second copy of a constant or a wrapper around a function to drift from the one the page uses
  const shared = new Set([...Object.keys(Geo), ...Object.keys(Babel), ...Object.keys(Proto)]);
  const copies = Object.keys(R).filter(k => shared.has(k));
  check(copies.length === 0, `rules.ts copies nothing from geometry.js, babel.js or protocol.js${copies.length ? ` (copies: ${copies})` : ''}`);
  const src = readFileSync(new URL('../src/rules.ts', import.meta.url), 'utf8');
  check(!/export \{[^}]*\} from/.test(src) && !/export \*/.test(src), 'rules.ts re-exports nothing');
  // the values the server has always had (so nothing moved under anyone's feet)
  const was = { G: 7, SHAFT: 30, SEG: 20, UNIT_D: 0.3, FLOOR_PITCH: 3.2, STAIR_PERIOD: 40, STAIR_OFF: 10, STAIR_LEN: 4.8, HOLE0: 0,
    STAIR_X0: -2.3, STAIR_X1: -0.08, WALK: 1.5, RUN: 4.2, TERMINAL: 40, FALL_FLOORS_PER_S: 12.5, REACH: 3 } as Record<string, number>;
  const ours = { CLAIM_METRES: 160, CLAIM_WINDOW_S: 60, AGENT_X: -3.2, STAIR_X: -1.19, REACH_SLACK: 0.5, SPEED_SLACK: 1.25 } as Record<string, number>;
  const moved = [...Object.keys(was).filter(k => !near((Geo as Record<string, unknown>)[k] as number, was[k])),
    ...Object.keys(ours).filter(k => !near((R as Record<string, unknown>)[k] as number, ours[k]))];
  check(moved.length === 0, `geometry.js and rules.ts values as before${moved.length ? ` (moved: ${moved})` : ''}`);
  check(R.SPAWN.x === -3.2 && R.SPAWN.y === 4 && R.SPAWN.floor === 0, 'spawn as before');
}
{
  const html = readFileSync(new URL('../web/short-stay-library.html', import.meta.url), 'utf8');
  check(/import \{[\s\S]*?\} from '\.\/geometry\.js'/.test(html), 'the page imports geometry.js');
  const copies = ['G', 'S', 'SEG', 'FLOOR_PITCH', 'UNIT_D', 'STAIR_PERIOD', 'STAIR_OFF', 'STAIR_LEN', 'EYE', 'WALK', 'RUN', 'TERMINAL', 'GRAV', 'ALPHABET']
    .filter(k => new RegExp(`(const|let|,)\\s*${k}\\s*=\\s*[-\\d'.]`).test(html));
  check(copies.length === 0, `the page keeps no copy of the shared constants${copies.length ? ` (copies: ${copies})` : ''}`);
  check(!/function groundAt\(|function resolve\(|\(2 \* j \+ 1\) \* SEG/.test(html), 'the page uses geometry.js for the ground, collisions and the shaft crossing');
}

// ---------------------------------------------------------------- stairs
check(Geo.nearestStairFoot(0) === 10 && Geo.nearestStairFoot(29) === 10 && Geo.nearestStairFoot(31) === 50 && Geo.nearestStairFoot(-25) === -30,
  'nearestStairFoot at 0, 29, 31, -25');
check(Geo.nearStair(10) && Geo.nearStair(14.8) && Geo.nearStair(15.8) && Geo.nearStair(9) && Geo.nearStair(-30) && Geo.nearStair(50.5),
  'nearStair on and within a metre of a run');
check(!Geo.nearStair(16) && !Geo.nearStair(8.9) && !Geo.nearStair(30) && !Geo.nearStair(0) && !Geo.nearStair(-20), 'nearStair false away from the runs');
check(Geo.onStairRun(10) && Geo.onStairRun(14.8) && !Geo.onStairRun(14.9) && !Geo.onStairRun(9.99) && Geo.onStairRun(-30), 'onStairRun is the run itself');
check(Geo.inStairBand(-1.19) && !Geo.inStairBand(-2.3) && !Geo.inStairBand(-0.08) && !Geo.inStairBand(-3.2), 'stair band along the railing, not where agents walk');
check(near(Geo.groundAt(-1, 12.4, 2, 0.45), 1.6) && Geo.groundAt(-1, 12.4, 0, 0.05) < 0 && Geo.groundAt(-4, 12.4, 0, 0.05) === 0,
  'the ground: halfway up a flight is 1.6 m; beside the flight, the floor');
check(Geo.groundAt(1, 0, 0, 1) === -Infinity, 'no ground in the shaft');
// every floor change by the stairs that the page allows, the server accepts (byStair: x > STAIR_X0 - 0.5 && nearStair)
{
  let bad = 0;
  for (let y = -80; y < 80; y += 0.01) for (const x of [-2.29, -1.19, -0.09]) {
    const g = Geo.groundAt(x, y, 3.2, 3.2);
    const onFlight = Geo.inStairBand(x) && Geo.onStairRun(y) && g > 0 && g < 3.2;
    if (onFlight && !(x > Geo.STAIR_X0 - 0.5 && Geo.nearStair(y))) bad++;
  }
  check(bad === 0, 'everywhere on a flight the server counts as near a stair');
}

// ---------------------------------------------------------------- the shaft
{
  let bad = 0;
  for (let i = 0; i < 10000; i++) {
    const x = rnd() * 30, y = (rnd() - 0.5) * 1e6, a = Geo.acrossShaft(x, y), b = Geo.acrossShaft(a.x, a.y);
    if (!near(b.x, x, 1e-6) || !near(b.y, y, 1e-6) || Math.floor(a.y / Geo.SEG) !== Math.floor(y / Geo.SEG)) bad++;
  }
  check(bad === 0, 'acrossShaft is its own inverse and keeps you in your segment, 10000 points');
  const m = Geo.acrossShaft(15, 3);
  check(m.x === 15 && m.y === 17, 'acrossShaft turns about the middle of the shaft and of the segment');
}

// ---------------------------------------------------------------- reach
{
  // the page offers a book where a ray from the eye meets the shelf face within REACH; the server must agree
  let bad = 0, worst = 0;
  for (let i = 0; i < 20000; i++) {
    const x = Geo.clampWalkway(-7 + rnd() * 7), y = rnd() * 40, yaw = rnd() * 2 * Math.PI, pitch = (rnd() - 0.5) * 2.4;
    const cp = Math.cos(pitch), dx = cp * Math.cos(yaw), dy = cp * Math.sin(yaw), dz = Math.sin(pitch);
    for (let t = 0.3; t <= Geo.REACH; t += 0.04) {   // the page's lookTarget
      const px = x + dx * t, py = y + dy * t, pz = Geo.EYE + dz * t;
      if (px > Geo.SHELF_FACE) continue;
      if (px < -Geo.G || pz < 0 || pz > Geo.UNIT_H) break;
      const b = Geo.bookAt(py, pz), d = R.shelfDistance(x, y, b.unit);
      worst = Math.max(worst, d);
      if (!R.withinReach(x, y, b.unit)) bad++;
      break;
    }
  }
  check(bad === 0, `every book the page lets you open is within the server's reach (furthest ${worst.toFixed(2)} m of ${Geo.REACH + R.REACH_SLACK})`);
  check(R.withinReach(Geo.SHELF_FACE + 3.5, 5.5, 5) && !R.withinReach(Geo.SHELF_FACE + 3.51, 5.5, 5), 'reach boundary at REACH + REACH_SLACK');
  check(Geo.bookAt(5.02 + 0.03 * 31.5, Geo.shelfZ(5) + 0.1).slot === 31 && Geo.bookAt(5.5, Geo.shelfZ(5) + 0.1).shelf === 5
    && Geo.bookAt(Geo.slotY(7, 12), Geo.shelfZ(3) + 0.15).shelf === 3 && Geo.bookAt(Geo.slotY(7, 12), 1).slot === 12, 'bookAt inverts slotY and shelfZ');
}

// ---------------------------------------------------------------- speed
// Walk the page's way (step(): dt ≤ 0.05 s a frame, RUN at most, diagonals normalised, resolve against the walls,
// rails and stairs, cross the shaft past its middle) for up to 0.25 s between reports; the server's cap must allow it.
{
  let bad = 0, worst = 0, crossed = 0, oldBad = 0;
  for (let i = 0; i < 20000; i++) {
    const inShaft = rnd() < 0.4;
    let x = inShaft ? rnd() * 15 : Geo.clampWalkway(-7 + rnd() * 7), y = (rnd() - 0.5) * 200;
    let z = inShaft ? (rnd() - 0.5) * 4.4 : 0;
    const x0 = x, y0 = y, report = 0.02 + rnd() * 0.23;
    let yaw = rnd() * 2 * Math.PI, side = 0, t = 0, once = false;
    const f = [1, 0, -1][Math.floor(rnd() * 3)], s = [1, 0, -1][Math.floor(rnd() * 3)];
    while (t < report - 1e-9) {
      const dt = Math.min(0.05, report - t, 0.005 + rnd() * 0.05);
      const len = Math.hypot(f, s) || 1, cy = Math.cos(yaw), sy = Math.sin(yaw);
      [x, y] = Geo.resolve(x + (f * cy + s * sy) / len * Geo.RUN * dt, y + (f * sy - s * cy) / len * Geo.RUN * dt, x, y, z);
      if (x > Geo.MIDLINE) { if (!once) { const a = Geo.acrossShaft(x, y); x = a.x; y = a.y; yaw += Math.PI; side ^= 1; once = true; } else x = Geo.MIDLINE; }   // once a fall
      yaw += (rnd() - 0.5) * 0.4;   // turning while walking
      t += dt;
    }
    let horiz = Math.hypot(x - x0, y - y0);
    const cap = R.maxHorizontal(R.moveDt(report * 1000));
    if (side) {
      crossed++; horiz = x0 > 0 && x > 0 ? Geo.crossingDistance(x0, y0, x, y) : Infinity;
      const a = Geo.acrossShaft(x0, y0);   // the old measure, from the last report only
      if (Math.hypot(x - a.x, y - a.y) > cap) oldBad++;
    }
    worst = Math.max(worst, horiz / cap);
    if (horiz > cap) bad++;
  }
  check(bad === 0, `running the page's way for ≤ 0.25 s stays under the server's speed cap (20000 walks, ${crossed} across the shaft, worst ${(worst * 100).toFixed(0)}% of the cap)`);
  if (oldBad) console.log(`     note: ${oldBad} of those crossings land near a segment boundary, where acrossShaft(last report) alone would refuse them`);
  // and the cap does bite: twice running pace for 0.25 s, with no railing to step over, is refused
  check(R.maxHorizontal(R.moveDt(250)) < Geo.RUN * 2 * 0.25 + R.MOVE_STEP_SLACK, 'the speed cap refuses twice running pace');
  check(R.moveDt(10) === R.MOVE_DT_MIN && R.moveDt(1e7) === R.MOVE_DT_MAX, 'report intervals are clamped');
}

// the renderer draws a flight in the segments geometry.js names, at STAIR_IN_SEG: the same stairs physics and the server use
{
  let agree = true;
  for (let j = -50; j <= 50; j++) for (let i = 0; i < Geo.SEG * 10; i++) {   // every 10 cm, between the edges (an edge is a rounding error away from either answer)
    const ly = (i + 0.5) / 10, y = j * Geo.SEG + ly, drawn = Geo.segmentHasStair(j) && ly >= Geo.STAIR_IN_SEG && ly <= Geo.STAIR_IN_SEG + Geo.STAIR_LEN;
    if (drawn !== Geo.onStairRun(y)) { agree = false; break; }
  }
  check(agree, 'the stairs the page draws (segmentHasStair, STAIR_IN_SEG) are the ones you can climb (onStairRun)');
}

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all geometry checks passed');
