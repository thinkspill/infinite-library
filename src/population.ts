// Who is here: the people present in the library now, held in memory and found by where they are. Everyone else who
// has ever been stays in the store (src/store.ts) and is fetched one row at a time when needed, by id, secret hash or
// public id (src/world-core.ts does the fetching and hands them to adopt()).
//
// Nearness is one idea with a few rules, each a Nearness below: who someone sees as peers, who an agent's look
// reports, who hears of a mark being left, and which marks someone is sent. A rule is a number of floors up and down,
// metres along the gallery, and whether it sees across the shaft. Positions are always the body's current one
// (B.pos: an agent mid-walk is where its walk has got to, a person is carried forward from their last report), never
// the raw stored y, which for an agent is where it is going.
//
// Present: a human with an open socket; an agent that acted in the last AGENT_PRESENT_MS. Resident (held here):
// everyone present, plus anyone in motion (an agent's walk or fall), plus anyone whose trail could still back a claim
// (a page that reconnects may claim what it read just before), plus whoever the world has just fetched to act on;
// sweep() lets go of the rest. Nothing here touches the store, the clock or a socket: the caller passes `now`.
import * as Proto from '../web/protocol.js';
import * as B from './body.ts';
import { CLAIM_WINDOW_S } from './rules.ts';
import { acrossShaft } from '../web/geometry.js';
import type { PlayerRecord } from './store.ts';

// A player is a body in the library (src/body.ts: where it is and what it may do) plus who they are.
export interface Player extends B.Body, PlayerRecord {
  kind: B.Kind;
  // not persisted (nor are the body's legs, reading, velocity and trail)
  savedAt?: number; lastActAt?: number;
  ver?: number;                                      // bumped at each report: peers are re-sent only when someone's changed
}
// A person as others see them (web/protocol.js Person).
export interface Person {
  id: string; kind: B.Kind; name: string; x: number; y: number; floor: number; side: number; yaw: number;
  state: B.Pos['state']; vx?: number; vy?: number;
}

export const AGENT_PRESENT_MS = 10 * 60_000;
export const isPresent = (p: Player, now: number) =>
  p.kind === 'human' ? p.connected : now - (p.lastActAt ?? p.updatedAt) < AGENT_PRESENT_MS;
// On the move by the server's clock (an agent's walk or fall) or carried forward (a connected human with a velocity).
export const inMotion = (p: Player, now: number) =>
  !!(p.legs && p.legs[p.legs.length - 1].t1 > now) || !!p.fall || (p.connected && !!(p.vx || p.vy));
// Somewhere lately enough that a claim could still rest on it (B.plausible reads the trail back CLAIM_WINDOW_S).
export const recentTrail = (p: Player, now: number) => !!p.trail?.length && p.trail[p.trail.length - 1].t1 >= now - CLAIM_WINDOW_S * 1000;

// ------------------------------------------------------------------ the rules
export interface Nearness { floors: number; metres: number; acrossShaft: boolean }
// Peers: the people a person's page draws, sent every tick (the nearest MAX_PEERS, ranked by metres along the gallery
// plus PEER_FLOOR_METRES a floor). The far gallery's people count: across a 30 m shaft you can see them, where
// acrossShaft says they appear from your side.
export const PEERS: Nearness = { floors: 16, metres: 140, acrossShaft: true };
export const MAX_PEERS = 32, PEER_FLOOR_METRES = 20;
// An agent's look: "other people nearby". Its own gallery only, and closer: an agent's world is the words it is given,
// and the people worth naming are those it could walk up to. (People across the shaft are deliberately left out: this
// is the one rule that does not look across, as it never has.)
export const LOOK: Nearness = { floors: 2, metres: 60, acrossShaft: false };
// Who is told when a mark is left: on its side, within two floors and 140 m of it.
export const MARK_NEWS: Nearness = { floors: 2, metres: 140, acrossShaft: false };
// Which marks someone is sent: those within MARK_NEWS of the middle of the MARK_CELL-metre stretch they stand in,
// re-sent when they move to another stretch, floor or side.
export const MARK_CELL = 20;

export interface Spot { side: number; floor: number; y: number }   // where someone is
export interface Seen extends Spot { x: number }                     // and how far out from the wall (x > 0: the shaft)

/** Where `o` appears along the gallery to someone on `side`: its own y on the same side; from across the shaft, where
 * acrossShaft puts it on this side, or null when the rule doesn't look across. */
export function seenAlong(rule: Nearness, side: number, o: Seen): number | null {
  if (o.side === side) return o.y;
  return rule.acrossShaft ? acrossShaft(o.x, o.y).y : null;
}
export function isNear(rule: Nearness, viewer: Spot, o: Seen): boolean {
  const y = seenAlong(rule, viewer.side, o);
  return y !== null && Math.abs(o.floor - viewer.floor) <= rule.floors && Math.abs(y - viewer.y) <= rule.metres;
}
/** Does someone at `at` (their current position) hear of a mark left on this book? */
export const hearsOfMark = (mark: { side: number; floor: number; unit: number }, at: Spot) =>
  isNear(MARK_NEWS, at, { side: mark.side, floor: mark.floor, y: mark.unit, x: -1 });
/** The stretch whose marks someone at `at` is sent: a key (re-send when it changes), and where to look from. */
export function marksStretch(at: Spot) {
  const c = Math.floor(at.y / MARK_CELL);
  return { key: `${at.side}:${at.floor}:${c}`, side: at.side, floor: at.floor, y: c * MARK_CELL + MARK_CELL / 2, floors: MARK_NEWS.floors, metres: MARK_NEWS.metres };
}

// ------------------------------------------------------------------ an instant's index of who is where
export interface Entry { id: string; ver: string; json: string; person: Person; side: number; floor: number; x: number; y: number }
interface Placed { e: Entry; y: number }   // y: as seen from the viewing side

// Everyone present at one instant, in cells of (viewing side × floor × CELL metres), as each side sees them, so a
// question looks at a handful of cells, not at everyone. Candidates are gathered once per (rule, side, floor, cell)
// and shared by everyone asking from that cell.
export class Snapshot {
  static readonly CELL = PEERS.metres;
  readonly entries: Entry[];
  private views: [Map<number, Map<number, Placed[]>>, Map<number, Map<number, Placed[]>>] = [new Map(), new Map()];
  private groups = new Map<string, Placed[]>();
  constructor(entries: Entry[]) {
    this.entries = entries;
    for (const e of entries) for (const viewer of [0, 1]) {
      const y = e.side === viewer ? e.y : acrossShaft(e.x, e.y).y, byFloor = this.views[viewer];
      let cells = byFloor.get(e.floor); if (!cells) byFloor.set(e.floor, cells = new Map());
      const k = Math.floor(y / Snapshot.CELL);
      let bk = cells.get(k); if (!bk) cells.set(k, bk = []); bk.push({ e, y });
    }
  }
  // Everyone who might be within `rule` of anyone in the viewer's cell (not yet filtered by distance).
  private around(rule: Nearness, v: Spot): Placed[] {
    const c = Math.floor(v.y / Snapshot.CELL), gk = `${rule.floors}/${rule.metres}/${rule.acrossShaft ? 1 : 0}/${v.side}/${v.floor}/${c}`;
    let cand = this.groups.get(gk);
    if (cand) return cand;
    cand = []; const byFloor = this.views[v.side], span = Math.ceil(rule.metres / Snapshot.CELL);
    for (let f = v.floor - rule.floors; f <= v.floor + rule.floors; f++) {
      const cells = byFloor.get(f); if (!cells) continue;
      for (let k = c - span; k <= c + span; k++) {
        const bk = cells.get(k); if (!bk) continue;
        for (const pl of bk) if (rule.acrossShaft || pl.e.side === v.side) cand.push(pl);
      }
    }
    this.groups.set(gk, cand);
    return cand;
  }
  /** Everyone within `rule` of v but `except` (a public id), in no particular order. */
  within(rule: Nearness, v: Spot, except?: string): Entry[] {
    return this.around(rule, v).filter(pl => pl.e.id !== except && Math.abs(pl.y - v.y) <= rule.metres).map(pl => pl.e);
  }
  /** The k nearest within `rule` of v but `except`, by metres along plus PEER_FLOOR_METRES a floor, in no particular order. */
  nearest(rule: Nearness, v: Spot, k: number, except?: string): Entry[] {
    const cand = this.around(rule, v), idx: number[] = [], dist: number[] = [];
    for (let i = 0; i < cand.length; i++) {
      const pl = cand[i], d = Math.abs(pl.y - v.y);
      if (pl.e.id !== except && d <= rule.metres) { idx.push(i); dist.push(d + PEER_FLOOR_METRES * Math.abs(pl.e.floor - v.floor)); }
    }
    const n = selectNearest(idx, dist, k), out: Entry[] = [];
    for (let j = 0; j < n; j++) out.push(cand[idx[j]].e);
    return out;
  }
}

// ------------------------------------------------------------------ who is held in memory
export class Population<P extends Player = Player> {
  private byId = new Map<string, P>();
  private byPub = new Map<string, P>();
  // The humans with an open socket here: the MAX_HUMANS count. Kept only by connect/disconnect/remove/clear, so it is
  // always exactly the held humans whose p.connected is true (the store writes p.connected too, but nothing reads it back: on waking, who is connected is rebuilt from the open sockets).
  private online = new Set<string>();

  get size() { return this.byId.size; }
  get(id: string): P | undefined { return this.byId.get(id); }
  withPub(pubId: string): P | undefined { return this.byPub.get(pubId); }
  all(): IterableIterator<P> { return this.byId.values(); }
  /** Hold p, unless someone with its id is already held: then that one (the live one) is returned. */
  adopt(p: P): P {
    const hit = this.byId.get(p.id); if (hit) return hit;
    this.byId.set(p.id, p); this.byPub.set(p.pubId, p);
    return p;
  }
  /** Someone's socket is open here: hold p (or the one already held with its id: that one is returned), mark them
   * connected, and count them toward the crowd if human. Idempotent: a second tab is still one person. */
  connect(p: P): P {
    const q = this.adopt(p);
    q.connected = true; if (q.kind === 'human') this.online.add(q.id);
    return q;
  }
  /** Their last socket closed: not connected, carried forward no further, not counted. Still held, until a sweep lets
   * go of them; the caller saves them (the store keeps p.connected). */
  disconnect(p: P) {
    p.connected = false; p.vx = p.vy = 0; this.online.delete(p.id);
  }
  /** How many humans have a socket open here (what MAX_HUMANS caps). */
  get humansOnline() { return this.online.size; }
  /** Whether this person is a human counted toward the cap. */
  isOnline(id: string) { return this.online.has(id); }
  remove(id: string) {
    const p = this.byId.get(id); if (!p) return;
    this.byId.delete(id); if (this.byPub.get(p.pubId) === p) this.byPub.delete(p.pubId); this.online.delete(id);
  }
  clear() { this.byId.clear(); this.byPub.clear(); this.online.clear(); }
  present(now: number): P[] { const out: P[] = []; for (const p of this.byId.values()) if (isPresent(p, now)) out.push(p); return out; }
  names(): Set<string> { const s = new Set<string>(); for (const p of this.byId.values()) s.add(p.name); return s; }
  anyInMotion(now: number) { for (const p of this.byId.values()) if (inMotion(p, now)) return true; return false; }
  /** Let go of whoever is neither present, nor connected, nor in motion, nor lately somewhere a claim could rest on;
   * returns them (each was saved when last changed). */
  sweep(now: number): P[] {
    const gone: P[] = [];
    for (const p of this.byId.values()) if (!p.connected && !isPresent(p, now) && !inMotion(p, now) && !recentTrail(p, now)) gone.push(p);
    for (const p of gone) this.remove(p.id);
    return gone;
  }
  /** Everyone present at `now`, as others see them; describe() gives each one's Person and a version that changes when
   * they need re-sending, and where they are is the Person's position. */
  snapshot(now: number, describe: (p: P) => { person: Person; ver: string }): Snapshot {
    const entries: Entry[] = [];
    for (const p of this.byId.values()) {
      if (!isPresent(p, now)) continue;
      const { person, ver } = describe(p);
      entries.push({ id: person.id, ver, json: Proto.encode(Proto.person(person)), person, side: person.side, floor: person.floor, x: person.x, y: person.y });
    }
    return new Snapshot(entries);
  }
}

// Moves the k smallest dist (with their idx alongside) to the front, in no particular order; returns how many (≤ k).
// Quickselect: linear on average, where a sort would be n log n for every socket on every tick.
export function selectNearest(idx: number[], dist: number[], k: number) {
  const n = idx.length; if (n <= k) return n;
  let lo = 0, hi = n - 1;
  const swap = (a: number, b: number) => { let t = idx[a]; idx[a] = idx[b]; idx[b] = t; t = dist[a]; dist[a] = dist[b]; dist[b] = t; };
  while (lo < hi) {
    const pivot = dist[(lo + hi) >> 1]; let i = lo, j = hi;
    while (i <= j) { while (dist[i] < pivot) i++; while (dist[j] > pivot) j--; if (i <= j) { swap(i, j); i++; j--; } }
    if (k - 1 <= j) hi = j; else if (k - 1 >= i) lo = i; else break;
  }
  return k;
}
