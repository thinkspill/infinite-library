// A body in the library: what someone standing (or falling) in the gallery can do, as pure functions over plain data.
// Nothing here reads the clock, the database or a socket: the caller passes `now` and the settings in and gets a
// verdict back (a position or a correction, a reason or null, a new trail), and World applies it. That makes the
// rules the same for a person over a WebSocket and an agent over MCP, and checkable without a server
// (scripts/check-body.ts).
import * as R from './rules.ts';
import type { Address } from './rules.ts';
import * as Geo from '../web/geometry.js';
import { SIDES, PAGES, LINES, COLS } from '../web/babel.js';
import { isAddress, sideOf } from '../web/protocol.js';

export type Kind = 'human' | 'agent';
export type MarkKind = 'note' | 'open_book';
export interface Leg { t0: number; t1: number; y0: number; y1: number; floor: number; x: number }
// a stretch of one floor's gallery someone was on, from t0 to t1
export interface Stretch { side: number; floor: number; lo: number; hi: number; t0: number; t1: number }
export interface Reading { addr: Address; page: number }
export interface Body {
  kind: Kind;
  x: number; y: number; floor: number; yaw: number;
  side: number;                                      // 0 east, 1 west (SIDES)
  fall: { t0: number; floor: number } | null;       // agents only: falling down the shaft since t0
  legs?: Leg[];                                      // agents only: a walk or stair climb in progress
  reading?: Reading;
  lastMoveAt?: number;
  vx?: number; vy?: number;                          // humans: velocity as last reported, for dead reckoning
  crossed?: boolean;                                 // humans mid-fall: already crossed the shaft this fall (once a fall)
  settling?: boolean;                                // humans just out of the shaft over a railing, maybe still dropping onto the walkway
  trail?: Stretch[];                                 // where they have been lately, for judging claims
}
export interface Pos { x: number; y: number; floor: number; state: 'falling' | 'walking' | 'reading' | 'standing' }
export type Verdict<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

// Humans are carried forward from their last report for at most this long.
export const EXTRAPOLATE_S = Geo.EXTRAPOLATE_S;
// Where an agent stands to take a book down: it steps up to the shelf (people walk there themselves).
export const SHELF_X = -Geo.G + Geo.UNIT_D + 0.35;

// ------------------------------------------------------------------ night
// Every NIGHT_PERIOD_S seconds, offset NIGHT_OFFSET_S from the epoch (wrangler vars, as strings): night n, and when n+1 falls.
export interface NightSettings { NIGHT_PERIOD_S?: unknown; NIGHT_OFFSET_S?: unknown }
export function night(s: NightSettings, now: number) {
  const period = Number(s.NIGHT_PERIOD_S) || 86400, off = Number(s.NIGHT_OFFSET_S) || 0;
  const n = Math.floor((now / 1000 - off) / period);
  return { n, nextAt: ((n + 1) * period + off) * 1000 };
}

// ------------------------------------------------------------------ where
// Where a body is at `now`: agents may be mid-walk or mid-fall on the server's clock, humans are carried forward.
export function pos(b: Body, now: number): Pos {
  if (b.fall) {
    const s = Math.max(0, (now - b.fall.t0) / 1000);
    return { x: 1, y: b.y, floor: b.fall.floor - Math.floor(s * Geo.FALL_FLOORS_PER_S), state: 'falling' };
  }
  const leg = b.legs?.find(l => now < l.t1);
  if (leg) {
    const k = now <= leg.t0 ? 0 : (now - leg.t0) / (leg.t1 - leg.t0);
    return { x: leg.x, y: leg.y0 + (leg.y1 - leg.y0) * k, floor: leg.floor, state: 'walking' };
  }
  let x = b.x, y = b.y;
  if (b.kind === 'human' && (b.vx || b.vy) && b.lastMoveAt) {   // carried forward from their last report
    const t = Math.min(EXTRAPOLATE_S, Math.max(0, (now - b.lastMoveAt) / 1000));
    x = Math.max(-Geo.G, Math.min(Geo.SHAFT, x + (b.vx ?? 0) * t)); y += (b.vy ?? 0) * t;
  }
  return { x, y, floor: b.floor, state: x > 0 ? 'falling' : b.reading ? 'reading' : (b.vx || b.vy) ? 'walking' : 'standing' };
}
// Legs all walked: the body is where they led (World drops them).
export const arrived = (b: Body, now: number) => !b.legs || b.legs[b.legs.length - 1].t1 <= now;

// Why an agent can't set out on a verb right now (on its way, or falling until night at nextAt), or null.
export function busy(b: Body, now: number, nextAt: number): string | null {
  const p = pos(b, now);
  if (p.state === 'walking') return `still on your way; you arrive in ${Math.ceil((b.legs![b.legs!.length - 1].t1 - now) / 1000)} s`;
  if (p.state === 'falling') return `you are falling, and will fall until night (in ${fmtDuration(nextAt - now)})`;
  return null;
}

// ------------------------------------------------------------------ moving (humans report, the server judges)
export type MoveVerdict =
  | { ok: true; to: { x: number; y: number; floor: number; yaw: number; side: number; vx: number; vy: number; crossed: boolean; settling: boolean };
      crossed: boolean; fell: boolean; changedFloor: boolean; keepReading: boolean; stretch: { floor: number; y0: number; y1: number } }
  | { ok: false; correct: { x: number; y: number; floor: number; side: number; reason: string; crossed: boolean } };
// A reported position: accepted, corrected back to where they were, or null for a malformed report (ignored).
export function judgeMove(b: Body, m: Record<string, unknown>, now: number): MoveVerdict | null {
  const x = m.x, y = m.y, floor = m.floor, yaw = m.yaw, side = m.side === undefined ? b.side : m.side;
  // velocity (m/s along x and y), for carrying them forward between reports; capped at a hurried pace
  const vmax = R.MAX_REPORTED_SPEED, clampV = (v: unknown) => typeof v === 'number' && isFinite(v) ? Math.max(-vmax, Math.min(vmax, v)) : 0;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof yaw !== 'number' || !Number.isSafeInteger(floor)
      || !isFinite(x) || !isFinite(y) || !isFinite(yaw) || Math.abs(y) > 1e12 || (side !== 0 && side !== 1)) return null;
  const f = floor as number;
  // Cap the elapsed time so a client can't bank an hour of silence and spend it on one leap.
  const dt = R.moveDt(now - (b.lastMoveAt ?? now));
  // Speed cap: running pace plus slack for jitter and the step over the railing; floors change by the
  // stairs (one at a time) or by falling at terminal velocity.
  let horiz = Math.hypot(x - b.x, y - b.y);
  const maxHoriz = R.maxHorizontal(dt);
  // Steering across the shaft while falling is the only way to the other side: it hands the body over to the
  // far gallery's frame (Geo.acrossShaft), so a change of side is measured through that, and only mid-air.
  // Crossing the shaft (a change of side) is only mid-air, and once a fall (geometry.js MIDLINE): a second crossing
  // would be over and back through different segments' mirrors, a free 2 * SEG along. Back on a walkway, the fall ends.
  const crossed = side !== b.side;
  if (crossed) horiz = b.x > 0 && x > 0 && !b.crossed ? Geo.crossingDistance(b.x, b.y, x, y) : Infinity;
  const crossedThisFall = x <= 0 ? false : !!b.crossed || crossed;
  const maxFloors = 1 + Math.ceil(Geo.FALL_FLOORS_PER_S * dt * 1.25);
  const inBounds = x >= -Geo.G && x <= Geo.SHAFT;
  // Off the shaft, floors change only one at a time, at a stair.
  // Out of the shaft over a lower floor's railing, a faller can still be dropping onto that walkway for a report or
  // two (the page reports leaving the shaft at once): until the floor stops changing, they may still go down.
  const settling = !!b.settling && x <= 0;
  const falling = b.x > 0 || x > 0 || (settling && f <= b.floor);
  const df = Math.abs(f - b.floor);
  const byStair = df === 0 || (df === 1 && x > Geo.STAIR_X0 - 0.5 && Geo.nearStair(y));
  // nobody falls upwards: mid-air, a body may rise at most the one floor a stair would give
  const rising = f - b.floor > 1;
  if (!inBounds || horiz > maxHoriz || df > maxFloors || rising || (!falling && !byStair))
    return { ok: false, correct: { x: b.x, y: b.y, floor: b.floor, side: b.side, reason: 'too fast', crossed: !!b.crossed } };
  return { ok: true, to: { x, y, floor: f, yaw, side: side as number, vx: clampV(m.vx), vy: clampV(m.vy), crossed: crossedThisFall, settling: x <= 0 && (b.x > 0 || (settling && f !== b.floor)) },
    crossed, fell: b.x <= 0 && x > 0, changedFloor: f !== b.floor, keepReading: !!m.reading,
    stretch: { floor: f, y0: crossed || f !== b.floor ? y : b.y, y1: y } };
}

// ------------------------------------------------------------------ moving (agents ask, the server walks them)
export interface Trip { legs: Leg[]; to: { x: number; y: number; floor: number }; arriveAt: number }
export function planWalk(from: Pos, metres: number, run: boolean, now: number, maxS: number): Trip & { metres: number } {
  const speed = run ? Geo.RUN : Geo.WALK, cap = speed * maxS, d = Math.max(-cap, Math.min(cap, metres));
  const t1 = now + Math.abs(d) / speed * 1000;
  return { legs: [{ t0: now, t1, y0: from.y, y1: from.y + d, floor: from.floor, x: R.AGENT_X }], to: { x: R.AGENT_X, y: from.y + d, floor: from.floor }, arriveAt: t1, metres: d };
}
// To the nearest stair foot (up) or opening (down) and along it to the next floor; or over the railing, which takes
// two seconds and then falls from fallAt.
export function planClimb(from: Pos, where: 'up' | 'down' | 'railing', now: number): Trip & { fallAt?: number } {
  if (where === 'railing')
    return { legs: [{ t0: now, t1: now + 2000, y0: from.y, y1: from.y, floor: from.floor, x: -0.3 }], to: { x: 1, y: from.y, floor: from.floor }, arriveAt: now + 2000, fallAt: now + 2000 };
  const legs: Leg[] = []; let t = now;
  const leg = (y0: number, y1: number, floor: number, x: number) => { const t1 = t + Math.abs(y1 - y0) / Geo.WALK * 1000; legs.push({ t0: t, t1, y0, y1, floor, x }); t = t1; };
  if (where === 'up') {
    const foot = Geo.nearestStairFoot(from.y);
    leg(from.y, foot, from.floor, R.AGENT_X);
    leg(foot, foot + Geo.STAIR_LEN, from.floor, R.STAIR_X);
    return { legs, to: { x: R.STAIR_X, y: foot + Geo.STAIR_LEN, floor: from.floor + 1 }, arriveAt: t };
  }
  const top = Geo.nearestStairFoot(from.y - Geo.STAIR_LEN) + Geo.STAIR_LEN;
  leg(from.y, top, from.floor, R.AGENT_X);
  leg(top, top - Geo.STAIR_LEN, from.floor - 1, R.STAIR_X);
  return { legs, to: { x: R.STAIR_X, y: top - Geo.STAIR_LEN, floor: from.floor - 1 }, arriveAt: t };
}

// ------------------------------------------------------------------ the trail, and who could have read what
// Where someone has been: humans as they move (a stretch per few seconds), agents by their walks as they set out.
// Returns the new trail, merged into its last stretch when it carries on from it, pruned to the claim window at now.
export function track(trail: readonly Stretch[] | undefined, s: Stretch, now: number): Stretch[] {
  const t = trail ?? [], last = t[t.length - 1];
  const next = last && last.side === s.side && last.floor === s.floor && s.t0 - last.t1 < 2000 && s.t1 - last.t0 < 5000
    ? [...t.slice(0, -1), { ...last, lo: Math.min(last.lo, s.lo), hi: Math.max(last.hi, s.hi), t1: Math.max(last.t1, s.t1) }]
    : [...t, s];
  const old = now - R.CLAIM_WINDOW_S * 1000;
  let i = 0; while (i < next.length && (next[i].t1 < old || next.length - i > 400)) i++;
  return i ? next.slice(i) : next;
}
export const stretch = (side: number, floor: number, y0: number, y1: number, t0: number, t1: number): Stretch =>
  ({ side, floor, lo: Math.min(y0, y1), hi: Math.max(y0, y1), t0, t1 });

// Could b have read a find on this side, floor and unit? Only if they were there, near enough, lately.
export function plausible(b: Body, side: number, floor: number, unit: number, now: number) {
  const here = pos(b, now), old = now - R.CLAIM_WINDOW_S * 1000, y = unit + 0.5;
  const near = (s: { side: number; floor: number; lo: number; hi: number }) => s.side === side && s.floor === floor && y >= s.lo - R.CLAIM_METRES && y <= s.hi + R.CLAIM_METRES;
  return near({ side: b.side, floor: here.floor, lo: here.y, hi: here.y }) || (b.trail ?? []).some(s => s.t1 >= old && s.t0 <= now && near(s));
}

// ------------------------------------------------------------------ reach, and the verbs that need it
// Why b can't take book a down from the shelf right now, or null.
export function cannotReach(b: Body, a: Address, now: number): string | null {
  const p = pos(b, now);
  if (b.fall || p.x > 0) return 'you are falling';
  if (b.side !== sideOf(a)) return 'that book is across the shaft';
  if (p.floor !== a.floor) return 'that book is on another floor';
  return R.withinReach(p.x, p.y, a.unit) ? null : 'out of reach';
}


// Take a book down: what they now hold, and where they stand to hold it. stepUp: they step up to the shelf first and
// reach from there (agents: MCP's "the unit in front of you"; people over a socket walk there themselves). Only an
// accepted open moves them.
export function open(b: Body, a: unknown, now: number, stepUp = false): Verdict<{ reading: Reading; x: number }> {
  if (!isAddress(a)) return { ok: false, reason: 'bad address' };
  const at = stepUp ? { ...b, x: SHELF_X } : b, why = cannotReach(at, a, now);
  return why ? { ok: false, reason: why } : { ok: true, reading: { addr: { ...a, side: sideOf(a) }, page: 1 }, x: at.x };
}
// Turn to page n of the book they hold.
export function turnTo(b: Body, n: unknown): Verdict<{ page: number }> {
  if (!b.reading) return { ok: false, reason: 'you are not holding a book; open one first' };
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > PAGES) return { ok: false, reason: `pages run 1-${PAGES}` };
  return { ok: true, page: n as number };
}
// Leave a book standing open. (How many marks a night is World's count to keep.)
export function mark(b: Body, a: unknown, kind: unknown, now: number): Verdict<{ address: Address; kind: 'open_book' }> {
  if (!isAddress(a)) return { ok: false, reason: 'bad address' };
  // Notes (free text others read) were removed before launch: a book left standing open is the only mark.
  if (kind === 'note') return { ok: false, reason: 'notes are gone: you can leave the book standing open (open_book)' };
  if (kind !== 'open_book') return { ok: false, reason: 'kind must be open_book' };
  const why = cannotReach(b, a, now);
  return why ? { ok: false, reason: why } : { ok: true, address: a, kind };
}

// ------------------------------------------------------------------ claims
export interface Claim { address: Address; side: number; page: number; at: number; len?: number }
export type ClaimResult =
  | { ok: false; reason: string }
  | { ok: true; first: boolean; rank: number; overall: number; side: string; text: string; finder: string; address: Address; page: number; at: number };
// Whether a claim is well formed, long enough to place (min: what each side's board needs) and something b could
// have read; the page itself is scanned by World.
export function judgeClaim(b: Body, c: unknown, min: readonly number[], now: number): Verdict<{ claim: Claim }> {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>, a = o.address, page = o.page, at = o.at, len = o.len;
  // len may be left out (agents): then it is whatever run starts at `at`
  if (!isAddress(a) || !Number.isInteger(page) || (page as number) < 1 || (page as number) > PAGES || !Number.isInteger(at)
    || (len !== undefined && (!Number.isInteger(len) || (len as number) > LINES * COLS))) return { ok: false, reason: 'bad claim' };
  const side = sideOf(a);
  if (len !== undefined && (len as number) < min[side]) return { ok: false, reason: `not rare enough for the ${SIDES[side]} board (needs ${min[side]}+ characters)` };
  if (!plausible(b, side, a.floor, a.unit, now))
    return { ok: false, reason: side !== b.side ? `that is on the ${SIDES[side]} side, across the shaft: claim what you find on your own side`
      : `too far away: you were not on floor ${a.floor} within ${R.CLAIM_METRES} m of it in the last ${R.CLAIM_WINDOW_S} s` };
  return { ok: true, claim: { address: a, side, page: page as number, at: at as number, ...(len === undefined ? {} : { len: len as number }) } };
}

// ------------------------------------------------------------------ the agents' address format
// Agents name a book as people read a shelf: shelf 1 at the bottom, book 1 at the lower-unit end, the side by name
// (their own if left out). The one translation to an Address, for open and claim.
export interface BookRef { floor: number; unit: number; side?: 'east' | 'west'; shelf: number; book: number }
export const addressOf = (r: BookRef, ownSide: number): Address =>
  ({ floor: r.floor, unit: r.unit, side: r.side ? (SIDES as readonly string[]).indexOf(r.side) : ownSide, shelf: r.shelf - 1, slot: r.book - 1 });
// A find as the claim tool takes it: page from 1, at the character offset on it, len if they know it.
export interface AgentClaim extends BookRef { page: number; at: number; len?: number }

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
}
