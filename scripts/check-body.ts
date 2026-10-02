// Checks src/body.ts, the rules of a body in the library, with no server: moving (speed, stairs, falling, crossing
// the shaft), reach, the claim trail and who could have read what, night, and the verbs people and agents share.
// Every case passes its own `now`, so nothing here depends on the clock. Run: node scripts/check-body.ts
import * as B from '../src/body.ts';
import * as R from '../src/rules.ts';
import * as Geo from '../web/geometry.js';
import { isAddress } from '../web/protocol.js';
import type { Body } from '../src/body.ts';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const T = 1_790_000_000_000;   // a fixed now
const human = (o: Partial<Body> = {}): Body => ({ kind: 'human', x: R.SPAWN.x, y: R.SPAWN.y, floor: 0, yaw: 0, side: 0, fall: null, lastMoveAt: T - 1000, ...o });
const agent = (o: Partial<Body> = {}): Body => ({ kind: 'agent', x: R.AGENT_X, y: R.SPAWN.y, floor: 0, yaw: 0, side: 0, fall: null, ...o });
const move = (b: Body, m: Record<string, unknown>, now = T) => B.judgeMove(b, { yaw: 0, ...m }, now);
const reason = (v: { ok: boolean } | null) => v && !v.ok ? ('correct' in v ? (v as { correct: { reason: string } }).correct.reason : (v as { reason: string }).reason) : null;

console.log('Night');
{
  const day = { NIGHT_PERIOD_S: '86400', NIGHT_OFFSET_S: '0' };
  const a = B.night(day, 5 * 86400_000 + 1);
  check(a.n === 5 && a.nextAt === 6 * 86400_000, `one a day at 00:00 UTC: night 5, the next at day 6 (${a.n}, ${a.nextAt})`);
  const b = B.night({}, 5 * 86400_000 - 1);
  check(b.n === 4 && b.nextAt === 5 * 86400_000, 'missing settings fall back to a day, no offset');
  const c = B.night({ NIGHT_PERIOD_S: '3600', NIGHT_OFFSET_S: '600' }, (10 * 3600 + 599) * 1000);
  check(c.n === 9 && c.nextAt === (10 * 3600 + 600) * 1000, `an hour long, 10 minutes offset: a second before the boundary is still night 9 (${c.n})`);
  const d = B.night({ NIGHT_PERIOD_S: '3600', NIGHT_OFFSET_S: '600' }, (10 * 3600 + 600) * 1000);
  check(d.n === 10 && d.nextAt === (11 * 3600 + 600) * 1000, 'and on the boundary it is night 10');
}

console.log('\nMoving');
{
  const b = human({ lastMoveAt: T - 100 });
  const jump = move(b, { x: R.SPAWN.x, y: R.SPAWN.y + 500, floor: 0 });
  check(reason(jump) === 'too fast' && !jump!.ok && jump!.correct.y === R.SPAWN.y && jump!.correct.floor === 0, 'a 500 m jump at dt 0.1 is put back where they were');
  const walk = move(human(), { x: R.SPAWN.x, y: R.SPAWN.y + Geo.WALK, floor: 0, vy: Geo.WALK });
  check(walk?.ok && walk.to.y === R.SPAWN.y + Geo.WALK && walk.to.vy === Geo.WALK, 'walking 1.5 m in a second is accepted');
  const run = move(human(), { x: R.SPAWN.x, y: R.SPAWN.y + Geo.RUN, floor: 0 });
  check(run?.ok, 'running 4.2 m in a second is accepted');
  const slack = move(human(), { x: R.SPAWN.x, y: R.SPAWN.y + Geo.RUN * 1.25 + 1.4, floor: 0 });
  const over = move(human(), { x: R.SPAWN.x, y: R.SPAWN.y + Geo.RUN * 1.25 + 1.6, floor: 0 });
  check(slack?.ok && !over?.ok, 'the cap is running pace × 1.25 + 1.5 m a report');
  const banked = move(human({ lastMoveAt: T - 3600_000 }), { x: R.SPAWN.x, y: R.SPAWN.y + 30, floor: 0 });
  check(!banked?.ok, 'an hour of silence buys no more than 2 s of travel');
  const fast = move(human(), { x: R.SPAWN.x, y: R.SPAWN.y, floor: 0, vy: 100 });
  check(fast?.ok && fast.to.vy === Geo.RUN * 1.25, 'a reported velocity is capped at a hurried pace');
  check(move(human(), { x: 'a', y: 4, floor: 0 }) === null && move(human(), { x: -3, y: 4, floor: 0.5 }) === null && move(human(), { x: -3, y: 4, floor: 0, side: 2 }) === null,
    'malformed reports are ignored (null), not corrected');
  check(!move(human(), { x: -Geo.G - 1, y: R.SPAWN.y, floor: 0 })?.ok, 'through the wall is put back');
}
{
  // stairs: from y 40n + 10 for 4.8 m, along the railing
  check(!Geo.nearStair(5) && Geo.nearStair(10), '(y 5 is not at a stair, y 10 is a stair foot)');
  const off = move(human({ y: 5 }), { x: -1, y: 5, floor: 1 });
  check(reason(off) === 'too fast', 'a floor change at y 5, away from the stairs, is refused');
  const on = move(human({ x: -1, y: 10 }), { x: -1, y: 10.5, floor: 1 });
  check(on?.ok && on.changedFloor && on.stretch.y0 === 10.5, 'a floor change at a stair foot is accepted (its stretch starts on the new floor)');
  const wall = move(human({ x: -6, y: 10 }), { x: -6, y: 10.5, floor: 1 });
  check(!wall?.ok, 'but not from the wall side of the walkway: the stairs run along the railing');
  const two = move(human({ x: -1, y: 10 }), { x: -1, y: 10.5, floor: 2 });
  check(!two?.ok, 'two floors at once by the stairs is refused');
}
{
  const over = move(human({ x: -0.2 }), { x: 0.8, y: R.SPAWN.y, floor: 0 });
  check(over?.ok && over.fell, 'stepping over the railing is accepted, and is a fall');
  const falling = human({ x: 1, y: 4, floor: 0 });
  const down = move(falling, { x: 1.5, y: 4, floor: -13 });
  check(down?.ok && !down.fell, 'falling 13 floors in a second is accepted (terminal velocity)');
  check(!move(falling, { x: 1.5, y: 4, floor: -30 })?.ok, 'falling 30 floors in a second is refused');
}
{
  const onFoot = move(human(), { x: R.SPAWN.x, y: R.SPAWN.y, floor: 0, side: 1 });
  check(reason(onFoot) === 'too fast' && !onFoot!.ok && onFoot!.correct.side === 0, 'changing sides on foot is put back');
  const mid = human({ x: 14, y: 4 }), a = Geo.acrossShaft(14, 4);
  const cross = move(mid, { x: a.x + 0.5, y: a.y, floor: 0, side: 1 });
  check(cross?.ok && cross.crossed && cross.to.side === 1 && cross.stretch.y0 === a.y, `falling past the middle of the shaft crosses to the west side, in its frame (x ${a.x}, y ${a.y})`);
  check(!move(mid, { x: 14.5, y: 4, floor: 0, side: 1 })?.ok, 'but not while staying put in the old frame');
}

console.log('\nWhere a body is');
{
  const p = B.pos(human({ vy: 1.5, lastMoveAt: T - 10_000 }), T);
  check(p.y === R.SPAWN.y + 4.5 && p.state === 'walking', 'a person is carried forward from their last report, 3 s at most');
  const w = agent({ legs: [{ t0: T, t1: T + 10_000, y0: 0, y1: 15, floor: 0, x: R.AGENT_X }], y: 15 });
  check(B.pos(w, T + 5000).y === 7.5 && B.pos(w, T + 5000).state === 'walking' && B.pos(w, T + 10_000).state === 'standing' && B.arrived(w, T + 10_000), 'an agent is halfway along a walk halfway through it');
  check(B.busy(w, T + 5000, T + 3600_000) === 'still on your way; you arrive in 5 s', 'and is busy until it arrives');
  const f = agent({ fall: { t0: T, floor: 0 }, x: 1 });
  check(B.pos(f, T + 1000).floor === -Math.floor(Geo.FALL_FLOORS_PER_S) && B.busy(f, T, T + 3600_000) === 'you are falling, and will fall until night (in 1 h 0 min)', 'a fall runs at terminal velocity until night');
  const walk = B.planWalk(B.pos(agent(), T), 1000, false, T, 30);
  check(walk.metres === 45 && walk.arriveAt === T + 30_000 && walk.to.y === R.SPAWN.y + 45, 'an agent walks at most 30 s a call');
  const up = B.planClimb(B.pos(agent(), T), 'up', T);
  check(up.to.floor === 1 && up.to.y === 10 + Geo.STAIR_LEN && up.legs.length === 2, 'climbing up goes to the nearest stair foot and up it');
  const rail = B.planClimb(B.pos(agent(), T), 'railing', T);
  check(rail.fallAt === T + 2000 && rail.to.x === 1, 'over the railing: two seconds, then the fall');
}

console.log('\nReach');
{
  const at = human({ x: -6, y: 5.3 }), addr = { floor: 0, unit: 5, shelf: 2, slot: 10 };
  check(B.cannotReach(at, addr, T) === null, 'a book in the unit in front of you is in reach');
  check(B.cannotReach(at, { ...addr, unit: 300 }, T) === 'out of reach', 'one 300 m along is out of reach');
  check(B.cannotReach(at, { ...addr, floor: 9 }, T) === 'that book is on another floor', 'one on another floor is refused');
  check(B.cannotReach(at, { ...addr, side: 1 }, T) === 'that book is across the shaft', 'one on the other side is across the shaft');
  check(B.cannotReach(human({ x: 1 }), addr, T) === 'you are falling', 'nothing is in reach mid-fall');
  check(B.cannotReach(human({ x: R.STAIR_X, y: 5.3 }), addr, T) === 'out of reach', 'from the railing, the shelves are out of reach');
}

console.log('\nThe trail, and who could have read what');
{
  const s1 = B.stretch(0, 0, 10, 12, T - 4000, T - 3000), s2 = B.stretch(0, 0, 12, 15, T - 2500, T - 1500);
  const t = B.track(B.track(undefined, s1, T), s2, T);
  check(t.length === 1 && t[0].lo === 10 && t[0].hi === 15 && t[0].t0 === T - 4000 && t[0].t1 === T - 1500, 'a stretch that carries on from the last is merged into it');
  check(s1.hi === 12 && s1.t1 === T - 3000, 'and the trail given is left as it was');
  const old = B.stretch(0, 0, 0, 1, T - 70_000, T - 61_000), t2 = B.track([old], B.stretch(0, 1, 0, 1, T, T), T);
  check(t2.length === 1 && t2[0].floor === 1, 'stretches older than the claim window are dropped');
  const early = 1000;   // a `now` near the epoch: with the clock read inside, everything here would be pruned
  const t3 = B.track([B.stretch(0, 0, 0, 1, 0, 500)], B.stretch(0, 1, 0, 1, 900, 1000), early);
  check(t3.length === 2, 'pruning uses the now it is given, not the clock');
  check(B.track(Array.from({ length: 400 }, (_, i) => B.stretch(0, i, 0, 1, T, T)), B.stretch(0, 999, 0, 1, T, T), T).length === 400, 'at most 400 stretches are kept');
}
{
  // someone now 1 km down the gallery, who was at y 10 on floor 0 a while ago
  const was = (agoS: number) => human({ y: 1000, trail: [B.stretch(0, 0, 10, 10, T - agoS * 1000 - 1000, T - agoS * 1000)] });
  check(!B.plausible(was(61), 0, 0, 180, T), 'a find 170 m from where they were 61 s ago: implausible');
  check(!B.plausible(was(30), 0, 0, 180, T), 'a find 170 m from where they were 30 s ago: implausible (too far)');
  check(!B.plausible(was(61), 0, 0, 100, T), 'a find 90 m from where they were 61 s ago: implausible (too long ago)');
  check(B.plausible(was(30), 0, 0, 100, T), 'a find 90 m from where they were 30 s ago: plausible');
  check(B.plausible(was(61), 0, 0, 1100, T), 'a find 100 m from where they stand now: plausible');
  check(!B.plausible(was(30), 0, 1, 100, T) && !B.plausible(was(30), 1, 0, 100, T), 'not on another floor, nor on the other side');
}

console.log('\nThe verbs people and agents share');
{
  const addr = { floor: 0, unit: 4, shelf: 2, slot: 10 };
  const person = human({ x: -6, y: 4.5 });
  const onStairs = agent({ x: R.STAIR_X, y: 4.5 });
  const o1 = B.open(person, addr, T), o2 = B.open(onStairs, addr, T, true);
  check(o1.ok && o2.ok && JSON.stringify(o1.reading) === JSON.stringify(o2.reading) && o1.reading.addr.side === 0,
    'open: a person at the shelf and an agent stepping up to it take down the same book');
  check(o2.ok && o2.x === B.SHELF_X && o1.ok && o1.x === person.x, 'the agent stands at the shelf after; the person where they were');
  const far = B.open(onStairs, { ...addr, unit: 300 }, T, true);
  check(!far.ok && far.reason === 'out of reach' && onStairs.x === R.STAIR_X, 'an agent refused a book out of reach is not moved (it used to be left at the shelf)');
  check(reason(B.open(onStairs, addr, T)) === 'out of reach', 'without stepping up, the railing is too far from the shelf');
  check(reason(B.open(person, { ...addr, floor: 3 }, T)) === reason(B.open(onStairs, { ...addr, floor: 3 }, T, true)) && reason(B.open(person, { ...addr, floor: 3 }, T)) === 'that book is on another floor',
    'open on another floor: the same reason for both');
  check(reason(B.open(person, { floor: 0, unit: 4, shelf: 7, slot: 0 }, T)) === 'bad address', 'open: a shelf that does not exist is a bad address');

  const holding = { ...onStairs, x: B.SHELF_X, reading: o2.ok ? o2.reading : undefined };
  const m1 = B.mark(person, addr, 'open_book', T), m2 = B.mark(holding, holding.reading!.addr, 'open_book', T);
  check(m1.ok && m2.ok && JSON.stringify({ ...m1.address, side: 0 }) === JSON.stringify(m2.address), 'mark: both leave the same book standing open');
  check(reason(B.mark(person, { ...addr, unit: 300 }, 'open_book', T)) === 'out of reach' && reason(B.mark(holding, { ...addr, unit: 300 }, 'open_book', T)) === 'out of reach', 'mark out of reach: refused for both');
  check(/^notes are gone/.test(reason(B.mark(person, addr, 'note', T)) ?? '') && reason(B.mark(person, addr, 'graffiti', T)) === 'kind must be open_book', 'mark: notes are gone, and open_book is the only kind');

  const trail = [B.stretch(0, 0, 0, 20, T - 10_000, T - 5000)];
  const claims = [
    { address: { floor: 0, unit: 10, side: 0, shelf: 3, slot: 11 }, page: 201, at: 3064, len: 12 },
    { address: { floor: -2, unit: 20, shelf: 1, slot: 29 }, page: 321, at: 2870, len: 12 },
    { address: { floor: 0, unit: 10, side: 1, shelf: 3, slot: 11 }, page: 201, at: 3064 },
    { address: { floor: 0, unit: 10, shelf: 3, slot: 11 }, page: 0, at: 1 },
    { address: { floor: 0, unit: 10, shelf: 3, slot: 11 }, page: 1, at: 1, len: 5 },
  ];
  const mins = [9, 9];
  const ph = claims.map(c => B.judgeClaim(human({ y: 500, trail }), c, mins, T)), pa = claims.map(c => B.judgeClaim(agent({ y: 500, trail }), c, mins, T));
  check(JSON.stringify(ph) === JSON.stringify(pa), 'claim: a person and an agent with the same trail get the same verdicts');
  check(ph[0].ok && ph[0].claim.side === 0 && ph[0].claim.len === 12, 'a find where they were lately is plausible');
  check(reason(ph[1]) === 'too far away: you were not on floor -2 within 160 m of it in the last 60 s', `one two floors down is not (${reason(ph[1])})`);
  check(reason(ph[2]) === 'that is on the west side, across the shaft: claim what you find on your own side', 'one across the shaft is not');
  check(reason(ph[3]) === 'bad claim' && reason(ph[4]) === 'not rare enough for the east board (needs 9+ characters)', 'a malformed claim, and a short one, are refused');
  check(reason(B.judgeClaim(human(), null, mins, T)) === 'bad claim', 'nothing at all is a bad claim');

  const a = B.addressOf({ floor: 3, unit: -7, shelf: 1, book: 32 }, 1), w = B.addressOf({ floor: 3, unit: -7, side: 'east', shelf: 6, book: 1 }, 1);
  check(a.side === 1 && a.shelf === 0 && a.slot === 31 && w.side === 0 && w.shelf === 5 && w.slot === 0 && isAddress(a) && isAddress(w),
    "agents' shelf and book count from 1, and a side left out is their own");
  check(!isAddress(B.addressOf({ floor: 0, unit: 0, shelf: 7, book: 1 }, 0)), 'and shelf 7 is no address');
  const t1 = B.turnTo(holding, 410), t2 = B.turnTo(holding, 411), t3 = B.turnTo(person, 2);
  check(t1.ok && t1.page === 410 && reason(t2) === 'pages run 1-410' && reason(t3) === 'you are not holding a book; open one first', 'turning pages: 1-410, and only in a book you hold');
}


console.log('\nFalling: never up, and across a segment\'s end');
{
  const mid = human({ x: 10, y: 50, floor: -5, lastMoveAt: T - 500 });
  check(move(mid, { x: 10, y: 50, floor: -2 })?.ok === false, 'falling up three floors is put back');
  check(move(mid, { x: 10, y: 50, floor: -6 })?.ok === true, 'falling down a floor is accepted');
  // over the shaft just short of a segment's end (y = 39.6 of 40), steering across: the far frame maps through the
  // neighbouring segment, so the naive distance is ~40 m; measured both ways round it is a short drift
  const edge = human({ x: 14, y: 39.6, floor: -5, lastMoveAt: T - 250 });
  const far = Geo.acrossShaft(14.4, 40.3);
  check(move(edge, { x: far.x, y: far.y, floor: -5, side: 1 })?.ok === true, `crossing the shaft at a segment's end is accepted (to ${far.y.toFixed(1)} m)`);
  // three segments: the last report just inside one (y -79.9), the page drifts 0.1 m into the next (-80.0) and crosses
  // there (landing at -100.0 across the shaft), then drifts on past that segment's end to -100.05
  const three = human({ x: 14.2, y: -79.9, floor: -5, lastMoveAt: T - 250 });
  check(move(three, { x: 15.6, y: -100.05, floor: -5, side: 1 })?.ok === true, 'crossing between three segments (report, crossing and landing in different ones) is accepted');
  // but the neighbouring segments give no free travel: landing 40 m along from where a crossing could have put you
  check(move(three, { x: 15.6, y: -140.05, floor: -5, side: 1 })?.ok === false, 'a "crossing" that lands a segment pair away is refused');
  check(move(three, { x: 15.6, y: -20.1, floor: -5, side: 1 })?.ok === false, 'and so is one the other way');
}
console.log('\nOne crossing a fall');
{
  const fall = human({ x: 14.9, y: 20.05, floor: -5, lastMoveAt: T - 250, crossed: false });
  const a = Geo.acrossShaft(15.1, 20.05);
  const first = move(fall, { x: a.x, y: a.y, floor: -5, side: 1 });
  check(first?.ok === true && (first as any).to.crossed === true, 'a first crossing is accepted, and remembered for the fall');
  const after = { ...fall, ...(first as any).to, y: 40.05, lastMoveAt: T - 250 };
  const back = Geo.acrossShaft(15.1, 40.05);
  check(move(after, { x: back.x, y: back.y, floor: -5, side: 0 })?.ok === false, 'a second crossing in the same fall is refused (it would be 40 m along)');
  const landed = move({ ...after, x: 0.4 }, { x: -0.5, y: 40.05, floor: -5, side: 1 });
  check(landed?.ok === true && (landed as any).to.crossed === false, 'stepping out onto a walkway ends the fall');
  const next = { ...after, ...(landed as any).to, x: 14.9, lastMoveAt: T - 250 };
  check(move(next, { x: back.x, y: back.y, floor: -5, side: 0 })?.ok === true, 'and the next fall may cross again');
  // out over a lower floor's railing while still in the air, then down onto that walkway: the drop is allowed
  const over = move(human({ x: 0.2, y: 16.75, floor: -73, lastMoveAt: T - 100 }), { x: -0.3, y: 16.75, floor: -73 }, T);
  check(over?.ok === true && (over as any).to.settling === true, 'leaving the shaft over a railing mid-air is settling');
  const settled = move({ ...human({ x: -0.3, y: 16.75, floor: -73, lastMoveAt: T - 100 }), settling: true }, { x: -0.44, y: 16.75, floor: -74 }, T);
  check(settled?.ok === true, 'and the drop onto the walkway a floor down is accepted');
  check(move(human({ x: -0.3, y: 16.75, floor: -73, lastMoveAt: T - 100 }), { x: -0.44, y: 16.75, floor: -74 }, T)?.ok === false, 'but a walkway floor change with no fall before it is still refused');
  // honest diagonal approach to a neighbouring segment's edge: the path run x and y together, not x and y apart
  const diag = human({ x: 9, y: 24, floor: -5, lastMoveAt: T - 2000, crossed: false });
  const m = Geo.acrossShaft(15.1, 17.9);
  check(move(diag, { x: m.x, y: m.y, floor: -5, side: 1 })?.ok === true, 'a diagonal run into the next segment and across is measured as one path');
}

console.log(failures ? `\n${failures} failed, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failures ? 1 : 0);
