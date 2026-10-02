// The library's world: every connection, every player present, every mark, the night. A single-threaded server
// process with its own SQLite file. It knows nothing of Cloudflare: what it needs from the runtime comes through a
// Host (below), which src/world.ts (the Durable Object) supplies from its ctx and env, and scripts/check-world.ts
// supplies offline with node:sqlite, fake sockets, a fake clock and fake timers.
//
// Its parts: the rules of a body (src/body.ts, pure), who is here and who is near whom (src/population.ts), every
// query (src/store.ts), and the wire protocol (web/protocol.js). This module applies the rules' verdicts: it keeps,
// sends, saves and logs.
import { blocked } from './blocklist.ts';
import * as R from './rules.ts';
import * as B from './body.ts';
import type { Kind, MarkKind, ClaimResult, AgentClaim } from './body.ts';
import { scanPageOf, type loadWords } from '../web/scan.js';
import { LIBRARY, SIDES, SHELVES, SLOTS, PAGES, pageText } from '../web/babel.js';
import { WALK, RUN, STAIR_LEN, nearestStairFoot } from '../web/geometry.js';
import { Store, type Sql, type Mark, type PlayerRecord } from './store.ts';
import * as Proto from '../web/protocol.js';   // the wire protocol, shared with the page and the test clients
import { Population, Snapshot, PEERS, LOOK, MAX_PEERS, isPresent, hearsOfMark, marksStretch, type Player, type Person } from './population.ts';

export type { Player };
export type Words = ReturnType<typeof loadWords>;

// ------------------------------------------------------------------ the host: what the world needs from its runtime
export interface Attachment { pid?: string; ip?: string }   // kept with each socket, surviving hibernation
export interface Sockets<S> {
  list(): S[];                                         // every open socket
  send(ws: S, text: string): void;                     // may throw while the socket closes: the world ignores that
  close(ws: S, code: number, reason: string): void;    // its close event comes back later (closed())
  attachment(ws: S): Attachment | null;
  attach(ws: S, a: Attachment): void;
}
export interface Host<S> {
  sql: Sql;                                            // the SQLite file (src/store.ts Sql)
  now(): number;                                       // the clock, ms
  schedule(ms: number, fn: () => void): void;          // run fn once, ms from now
  alarm: { get(): Promise<number | null>; set(at: number): Promise<void> | void };   // the one wake-up call (night)
  sockets: Sockets<S>;
  settings: Record<string, unknown>;                   // wrangler vars: NIGHT_*, MAX_HUMANS, SOCKETS_PER_IP, NEW_PER_IP_HOUR, ALLOW_SIDE_CHOICE
  words: Words;                                        // web/words.txt, parsed: claims are checked against it
}

interface Bucket { tokens: number; at: number }

// Load: humans report where they are going (position + velocity) when their course changes and every 2 s, not where
// they are ten times a second, and the server carries them forward between reports (at most B.EXTRAPOLATE_S). Positions are written to SQLite
// only when something happens (a floor or side, a fall, a stop) or every SAVE_EVERY_MS. Peers go out FLUSH_MS apart,
// found through the population's cells (src/population.ts), and only to sockets whose view changed. Past
// MAX_HUMANS connected, newcomers are turned away to walk alone ('full').
const SAVE_EVERY_MS = 60_000, FLUSH_MS = 250, PEERS_MIN_MS = 500, PEERS_RESEND_MS = 2000;
// Measured with scripts/load.ts on wrangler dev (one iMac core): 500 people crowded into one stretch stay responsive
// (22 ms median), more do not. 400 leaves room; the MAX_HUMANS setting overrides it (a wrangler var), e.g. for production.
export const MAX_HUMANS_DEFAULT = 400;
// From one network address (Cloudflare's CF-Connecting-IP, never stored): at most this many open sockets, and this many
// new people an hour. Generous, since a phone network or a campus can put many real people behind one address; the
// point is that one script can't create thousands of players or fill the night. Settings override both.
const SOCKETS_PER_IP_DEFAULT = 24, NEW_PER_IP_HOUR_DEFAULT = 60;
const MARKS_PER_NIGHT = 100, MAX_ACT_S = 30;   // message size and shape: web/protocol.js
// The leaderboard of rarest finds: the longest runs of English anyone's scanner has found, kept top 200, shown top 50.
// A claim must be at least MIN_CLAIM characters and beat the 200th; the first to claim a spot keeps the credit.
const BOARD_SHOW = 50, BOARD_KEEP = 200, MIN_CLAIM = 9, CLAIMS_PER_MSG = 16;
const ROSTER_DAYS = 30, ROSTER_MAX = 500;

export class WorldCore<S extends object> {
  // The SQLite file, its schema and every query (src/store.ts), which also counts today's usage, roughly as Cloudflare
  // bills it on the Free plan: Durable Object requests (each fetch, RPC and alarm is one; WebSocket messages in count 1
  // per 20) and SQLite rows read and written, the wake's own reads included.
  store!: Store;
  readonly people = new Population<Player>();
  private host: Host<S>; private sockets: Sockets<S>;
  private buckets = new Map<string, Bucket>();
  private marksKeys = new WeakMap<S, string>();
  private flushDue = false;
  private peersSent = new WeakMap<S, { key: string; at: number }>();
  private owners = new WeakMap<S, Player>();   // socket → player, so the attachment is decoded once per socket per wake
  private perIp = new Map<string, number>();   // open sockets per network address (rebuilt from attachments on waking)
  private dropped = new WeakSet<S>();           // close and error can both arrive for one socket: count it out once
  private boardCache: ReturnType<WorldCore<S>['boardNow']> | null = null;
  private boardDue = false;
  private rates = new Map<string, number>();
  // The map's roster: the store's most recent ROSTER_MAX, read once a wake when a map first asks, then kept fresh by
  // every save (the store's rows change only through save); people held here are read live.
  private rosterRows: Map<string, PlayerRecord> | null = null;
  private rosterCache: { at: number; value: ReturnType<WorldCore<S>['rosterNow']> } | null = null;
  // How many players there are (and how many are agents, or humans from before secrets), for the owner's diag: counted
  // in the store once a wake when first asked (a whole-table read), then kept by the changes made here.
  private counts: { n: number; legacy: number; agents: number } | null = null;

  constructor(host: Host<S>) { this.host = host; this.sockets = host.sockets; }

  // ------------------------------------------------------------------ waking
  // Opening the store migrates it if behind; then only who is here is read: the players the open sockets belong to,
  // and the agents active lately. Everyone else stays in the store until they are needed.
  async wake() {
    this.store = new Store(this.host.sql, { library: LIBRARY, keep: BOARD_KEEP, minClaim: MIN_CLAIM, now: () => this.host.now() });
    const now = this.host.now(), live = new Set<string>();
    for (const ws of this.sockets.list()) {
      const a = this.sockets.attachment(ws);
      if (a?.ip) this.perIp.set(a.ip, (this.perIp.get(a.ip) ?? 0) + 1);
      if (a?.pid) live.add(a.pid);
    }
    for (const r of this.store.playersById([...live])) { this.people.connect(fromStore(r)); }
    for (const r of this.store.agentsSeenSince(now - 10 * 60_000)) this.people.adopt(fromStore(r));
    if ((await this.host.alarm.get()) == null) await this.host.alarm.set(this.night(now).nextAt);
  }

  count(kind: 'requests' | 'wsIn') { this.store.count(kind); }
  usageToday() {
    const u = this.store.usage(), requests = u.requests + Math.ceil(u.wsIn / 20);
    const LIMIT = { requests: 100_000, rowsRead: 5_000_000, rowsWritten: 100_000 };   // Workers Free, per day, reset 00:00 UTC
    return { day: u.day, requests, wsIn: u.wsIn, rowsRead: u.rowsRead, rowsWritten: u.rowsWritten,
      ofLimit: { requests: requests / LIMIT.requests, rowsRead: u.rowsRead / LIMIT.rowsRead, rowsWritten: u.rowsWritten / LIMIT.rowsWritten } };
  }
  get maxHumans() { return this.setting('MAX_HUMANS', MAX_HUMANS_DEFAULT); }

  // ------------------------------------------------------------------ night
  night(now = this.host.now()) { return B.night(this.host.settings, now); }

  async alarm() {
    this.count('requests');
    const now = this.host.now(), { n, nextAt } = this.night(now);
    this.store.clearMarksBefore(n);
    // Night restores everyone who went over the railing to the gallery of whatever floor they had fallen to: those
    // held here, and those in the store (a person who fell and left, an agent falling unwatched).
    const restored: Player[] = [];
    const restore = (p: Player) => {
      const pos = this.pos(p, now);
      if (pos.x > 0 || p.fall) {
        Object.assign(p, { x: R.SPAWN.x, y: pos.y, floor: pos.floor, fall: null, legs: undefined, reading: undefined, crossed: false });   // the fall is over
        this.save(p, now); restored.push(p);
      }
    };
    for (const p of this.people.all()) restore(p);
    for (const r of this.store.inShaft()) if (!this.people.get(r.id)) restore(fromStore(r));
    this.event(null, 'night', { n, restored: restored.length });
    for (const ws of this.sockets.list()) {
      this.send(ws, Proto.W.night(n, nextAt));
      this.marksKeys.delete(ws);
      const p = this.playerOf(ws);
      if (p && restored.includes(p)) this.send(ws, Proto.W.correct({ x: p.x, y: p.y, floor: p.floor, side: p.side, reason: 'night' }));
      if (p) this.pushMarks(ws, p, now);
    }
    this.sweep(now);
    await this.host.alarm.set(nextAt);
  }

  // ------------------------------------------------------------------ WebSocket protocol
  // A new socket from `ip`: refused past the per-address cap, else accepted (accept() makes it) and remembered.
  connect(ip: string, accept: () => S): { ok: true; ws: S } | { ok: false; status: number; reason: string } {
    const cap = this.setting('SOCKETS_PER_IP', SOCKETS_PER_IP_DEFAULT);
    if ((this.perIp.get(ip) ?? 0) >= cap) return { ok: false, status: 429, reason: 'too many connections from one address' };
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    const ws = accept();
    this.sockets.attach(ws, { ip });
    return { ok: true, ws };
  }

  message(ws: S, raw: string | ArrayBuffer): Promise<void> | void {
    this.count('wsIn');
    // web/protocol.js reads and checks every message, the same module the page and the test clients build them with
    const d = Proto.decode(raw);
    if (!d.ok) { if (d.reason) this.send(ws, Proto.W.error(d.reason)); return; }
    if (d.msg.t === 'hello') return this.onHello(ws, d.msg);
    const p = this.playerOf(ws);
    if (!p) { this.send(ws, Proto.W.error(Proto.REASON.helloFirst)); this.close(ws, 4003, 'say hello first'); return; }   // not a conversation worth keeping
    if (!this.admit(p, 60)) return this.send(ws, Proto.W.error(Proto.REASON.rateLimited, String(d.msg.t)));
    const v = Proto.validate(d.msg);
    if (!v.ok) { if (v.reason) this.send(ws, Proto.W.error(v.reason, v.for)); return; }
    const m = v.msg as Record<string, unknown>;
    const now = this.host.now();
    // Each case only translates: the verbs (openBook, turnPage, addMark, claimFinds) are the same ones agents use.
    switch (m.t) {
      case 'move': return this.onMove(ws, p, m, now);
      case 'open': {
        const r = this.openBook(p, m.address, now);
        if (!r.ok) return this.send(ws, Proto.W.error(r.reason, 'open'));
        return;
      }
      case 'page': this.turnPage(p, m.n as number); return;   // already a page number (Proto clamps); no reply
      case 'close': p.reading = undefined; return;
      case 'mark': {
        const r = this.addMark(p, m.address, m.kind, now);
        return this.send(ws, r.ok ? Proto.W.marked(r.mark) : Proto.W.error(r.reason, 'mark'));
      }
      case 'map': if (!this.take('map:' + p.id, 0.5, 2)) return; return this.send(ws, Proto.W.roster(this.roster(now)));   // one every 2 s
      case 'finds': {   // Proto has checked each claim's shape; a malformed one stays in place, as null, so results line up
        const claims = (m.finds as { ok: boolean; claim?: unknown }[]).map(c => (c.ok ? c.claim : null));
        return this.send(ws, Proto.W.found(this.claimFinds(p, claims, now), this.board()));
      }
      case 'ping': return this.send(ws, Proto.W.pong(now, m.at0));   // at0 echoed, for round trips
      default: return this.send(ws, Proto.W.error(Proto.REASON.unknownType(m.t)));
    }
  }

  // A socket closed or errored (both may come for one socket: it is counted out once).
  closed(ws: S) {
    if (this.dropped.has(ws)) return;
    const p = this.playerOf(ws);
    this.dropped.add(ws);
    const ip = this.sockets.attachment(ws)?.ip;
    if (ip) { const n = (this.perIp.get(ip) ?? 1) - 1; if (n > 0) this.perIp.set(ip, n); else this.perIp.delete(ip); }
    if (!p) return;
    const others = this.sockets.list().some(o => o !== ws && !this.dropped.has(o) && this.playerOf(o) === p);
    if (!others) {
      this.people.disconnect(p);
      const now = this.host.now();
      this.save(p, now);   // and let go of at a sweep, once their trail is too old to back a claim (src/population.ts)
      this.scheduleFlush();
    }
  }

  private onHello(ws: S, m: Record<string, unknown>) {
    return this.hello(ws, m).catch(e => this.send(ws, Proto.W.error(String(e), 'hello')));
  }
  private async hello(ws: S, m: Record<string, unknown>) {
    const now = this.host.now();
    let p: Player | undefined;
    if (typeof m.token === 'string') {
      const a = await this.authAgent(m.token);
      if (!a) return this.send(ws, Proto.W.error('unknown or revoked key', 'hello'));
      p = this.people.get(a.id);
    } else if (typeof m.anon === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(m.anon)) {
      // The browser's secret logs in: found by its hash. A player from before 2026-10-02 (no hash yet, id 'h_' + secret)
      // is let in this once and handed a fresh secret ('rekey'); the old one, which had been public, then stops working.
      const hash = await sha256('anon:' + m.anon);
      let here = this.lookup(this.store.playerBySecret(hash)), legacy = false;
      if (!here) { const old = this.lookup(this.store.playerById('h_' + m.anon)); if (old && old.kind === 'human' && !old.secretHash) { here = old; legacy = true; } }
      // A crowded night: past MAX_HUMANS connected, a newcomer (not a returning tab) walks alone and tries again later.
      if (!here?.connected && this.people.humansOnline >= this.maxHumans) { this.send(ws, Proto.W.full(120)); this.close(ws, 4002, 'full'); return; }
      // A name you chose wins; otherwise you keep the one you were given, and newcomers (and the old default,
      // "wanderer") get a random one, so the map and the leaderboard aren't a column of identical names.
      const chosen = cleanName(m.name);
      if (!here) {   // a new person: limited per network address, so a script can't mint thousands
        const ip = this.sockets.attachment(ws)?.ip ?? 'unknown', perHour = this.setting('NEW_PER_IP_HOUR', NEW_PER_IP_HOUR_DEFAULT);
        if (!this.take('new:' + ip, perHour / 3600, perHour)) { this.send(ws, Proto.W.error('too many new arrivals from one place; try again later', 'hello')); this.close(ws, 4004, 'too many new'); return; }
      }
      // the last await: from here to the welcome nothing else runs, so whoever is adopted stays held (no sweep between)
      const fresh = legacy ? randomHex(24) : '', fh = legacy ? await sha256('anon:' + fresh) : '';
      p = here ? this.people.adopt(here) : this.getOrCreate('h_' + randomHex(12), 'human', chosen || this.randomName(), now, m.side, hash);
      if (legacy) {
        p.secretHash = fh; this.store.setSecret(p.id, fh); this.save(p, now); if (this.counts) this.counts.legacy--;
        this.send(ws, Proto.W.rekey(fresh));
      }
      const name = (!p.nameLocked && chosen) || (p.name === 'wanderer' || !cleanName(p.name) ? this.randomName() : p.name);
      if (name !== p.name) this.rename(p, name, now);
    } else return this.send(ws, Proto.W.error(Proto.REASON.needAnon, 'hello'));
    if (!p) return;
    // One live socket per identity: a second tab replaces the first.
    for (const o of this.sockets.list()) if (o !== ws && this.playerOf(o) === p) { this.send(o, Proto.W.replaced()); this.close(o, 4000, 'replaced'); }
    this.sockets.attach(ws, { pid: p.id, ip: this.sockets.attachment(ws)?.ip }); this.owners.set(ws, p); this.people.connect(p);
    p.lastMoveAt = now;
    this.save(p, now);
    const { n, nextAt } = this.night(now);
    this.send(ws, Proto.W.welcome({ you: { ...this.pub(p, now), crossed: !!p.crossed }, night: n, nextAt, rules: { walk: WALK, run: RUN }, board: this.board() }));
    this.pushMarks(ws, p, now);
    this.scheduleFlush();
  }

  // A person's report of where they are: judged by the body's rules (B.judgeMove), then kept, logged and passed on.
  private onMove(ws: S, p: Player, m: Record<string, unknown>, now: number) {
    const v = B.judgeMove(p, m, now);
    if (!v) return;
    p.lastMoveAt = now;
    if (!v.ok) return this.send(ws, Proto.W.correct(v.correct));
    const wasFalling = p.x > 0, wasMoving = !!(p.vx || p.vy);
    Object.assign(p, v.to); p.ver = (p.ver ?? 0) + 1;
    if (v.crossed) this.event(p, 'cross', { to: SIDES[p.side], floor: p.floor, y: p.y });
    p.trail = B.track(p.trail, B.stretch(p.side, v.stretch.floor, v.stretch.y0, v.stretch.y1, now, now), now);
    if (!v.keepReading) p.reading = undefined;
    if (v.fell) this.event(p, 'fall', { floor: p.floor, y: p.y });
    this.farthest(p, now);
    // written when something happens (a fall starting or ending among them: whether it crossed must survive the world
    // sleeping), else once a minute: the in-memory player is the live one
    const stopped = wasMoving && !p.vx && !p.vy;
    if (v.crossed || v.changedFloor || stopped || wasFalling !== (p.x > 0) || now - (p.savedAt ?? 0) > SAVE_EVERY_MS) this.save(p, now); else p.updatedAt = now;
    this.pushMarks(ws, p, now);
    this.scheduleFlush();
  }

  // ------------------------------------------------------------------ fan-out
  private scheduleFlush() {
    if (this.flushDue) return;
    this.flushDue = true;
    this.host.schedule(FLUSH_MS, () => { this.flushDue = false; this.flush(); });
  }
  // Everyone present, each turned into JSON once per tick (every socket's message is joined from these), and to each
  // socket whose view changed, its nearest MAX_PEERS under the PEERS rule (src/population.ts).
  flush() {
    const now = this.host.now(), sockets = this.sockets.list();
    this.sweep(now);
    if (!sockets.length) return;
    const snap = this.snapshot(now);   // once a tick
    for (const ws of sockets) {
      const me = this.playerOf(ws);
      if (!me) continue;
      const last = this.peersSent.get(ws);
      if (last && now - last.at < PEERS_MIN_MS) continue;   // at most twice a second each: clients carry people forward
      const pos = this.pos(me, now), near = snap.nearest(PEERS, { side: me.side, floor: pos.floor, y: pos.y }, MAX_PEERS, me.pubId);
      // only when someone in view changed (a new report, someone in or out), or a periodic refresh
      let key = ''; for (const e of near) key += e.id + ':' + e.ver + ';';
      if (last && last.key === key && now - last.at < PEERS_RESEND_MS) continue;
      this.peersSent.set(ws, { key, at: now - Math.random() * FLUSH_MS });   // jittered, so sockets fall due on different ticks
      let peers = ''; for (let j = 0; j < near.length; j++) peers += (j ? ',' : '') + near[j].json;
      try { this.sockets.send(ws, Proto.W.peersFrame(now, peers)); } catch { /* closing */ }
    }
    // Agents walk and fall on the server's clock, and humans are carried forward between reports: keep ticking while
    // anyone is in motion and someone is watching. (The roster for the map is sent when a map asks: 'map'.)
    if (this.people.anyInMotion(now)) this.scheduleFlush();
  }
  // Everyone present at now, as others see them.
  snapshot(now: number): Snapshot {
    return this.people.snapshot(now, p => {
      const person = this.pub(p, now), moving = !!(p.legs && p.legs[p.legs.length - 1].t1 > now) || !!p.fall;
      return { person, ver: moving ? `${person.x},${person.y},${person.floor}` : `${p.ver ?? 0}/${person.floor}/${p.side}/${p.name}` };   // agents move on the server's clock
    });
  }
  // Let go of whoever has stopped being here (src/population.ts sweep); each was saved when last changed.
  private sweep(now: number) { this.people.sweep(now); }

  private pushMarks(ws: S, p: Player, now: number) {
    const pos = this.pos(p, now), s = marksStretch({ side: p.side, floor: pos.floor, y: pos.y });
    if (this.marksKeys.get(ws) === s.key) return;
    this.marksKeys.set(ws, s.key);
    this.send(ws, Proto.W.marks(this.marksNear(s.side, s.floor, s.y, s.floors, s.metres)));
  }

  private marksNear(side: number, floor: number, y: number, floors: number, metres: number) {
    const { n } = this.night();
    return this.store.marksNear(n, side, floor, y, floors, metres);
  }

  // ------------------------------------------------------------------ the verbs, shared by WebSocket and MCP
  // One operation each, whoever acts: the body's rules (src/body.ts) judge, and these apply the verdict. The socket
  // handler and the agent* methods only translate to and from their formats, and rate-limit at their own edge.
  openBook(p: Player, address: unknown, now: number, stepUp = false): B.Verdict {
    const v = B.open(p, address, now, stepUp);
    if (!v.ok) return v;
    p.x = v.x; p.booksOpened++; p.reading = v.reading; this.save(p, now); this.scheduleFlush();
    return { ok: true };
  }
  turnPage(p: Player, n: unknown): B.Verdict {
    const v = B.turnTo(p, n);
    if (v.ok) p.reading!.page = v.page;
    return v;
  }
  addMark(p: Player, address: unknown, kind: unknown, now: number): B.Verdict<{ mark: Mark }> {
    const v = B.mark(p, address, kind, now);
    if (!v.ok) return v;
    const a = v.address, side = Proto.sideOf(a), { n } = this.night(now);
    const count = this.store.marksTonight(n, p.id);
    if (count >= MARKS_PER_NIGHT) return { ok: false, reason: `you have left ${MARKS_PER_NIGHT} marks tonight` };
    const mark = this.store.addMark({ night: n, side, floor: a.floor, unit: a.unit, shelf: a.shelf, slot: a.slot, kind: v.kind,
      text: '', author: p.id, authorName: p.name, createdAt: now });   // no text: an open book says nothing
    this.event(p, 'mark', { address: a, kind: v.kind });
    // told to everyone near it where they are now (an agent mid-walk is where its walk has got to, not where it is going)
    const out = Proto.encode(Proto.W.mark(mark)), place = { side, floor: a.floor, unit: a.unit };
    for (const ws of this.sockets.list()) {
      const o = this.playerOf(ws); if (!o) continue;
      const at = this.pos(o, now);
      if (hearsOfMark(place, { side: o.side, floor: at.floor, y: at.y })) try { this.sockets.send(ws, out); } catch { /* closing */ }
    }
    return { ok: true, mark };
  }

  // Where a player is right now (B.pos); legs walked to the end are dropped.
  pos(p: Player, now: number) {
    if (p.legs && B.arrived(p, now)) p.legs = undefined;
    return B.pos(p, now);
  }

  pub(p: Player, now: number): Person {
    const pos = this.pos(p, now);
    return { id: p.pubId, kind: p.kind, name: p.name, x: round2(pos.x), y: round2(pos.y), floor: pos.floor, side: p.side, yaw: round2(p.yaw), state: pos.state,
      ...(p.kind === 'human' && (p.vx || p.vy) ? { vx: round2(p.vx ?? 0), vy: round2(p.vy ?? 0) } : {}) };
  }

  // Everyone seen in the last ROSTER_DAYS, latest first, at most ROSTER_MAX: what the map lists. Built at most every 5 s
  // however many maps ask.
  roster(now: number) {
    if (this.rosterCache && now - this.rosterCache.at < 5000) return this.rosterCache.value;
    return (this.rosterCache = { at: now, value: this.rosterNow(now) }).value;
  }
  private rosterNow(now: number) {
    const cutoff = now - ROSTER_DAYS * 86400_000;
    if (!this.rosterRows) {
      this.rosterRows = new Map();
      for (const r of this.store.recentPlayers(cutoff, ROSTER_MAX)) this.rosterRows.set(r.id, fromStore(r));
    }
    const all = new Map<string, Player>();
    for (const [id, r] of this.rosterRows) all.set(id, this.people.get(id) ?? (r as Player));
    for (const p of this.people.all()) all.set(p.id, p);
    return [...all.values()].filter(p => p.updatedAt > cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, ROSTER_MAX)
      .map(p => ({ ...this.pub(p, now), present: this.people.get(p.id) === p && isPresent(p, now), updatedAt: p.updatedAt,
        farthestY: round2(p.farthestY), farthestFloor: p.farthestFloor, farthestAt: p.farthestAt, booksOpened: p.booksOpened }));
  }

  private farthest(p: Player, now: number) {
    const oy = Math.abs(p.farthestY), of = Math.abs(p.farthestFloor);
    if (Math.abs(p.y) > oy) { p.farthestY = p.y; p.farthestAt = now; if (crossedDecade(oy, Math.abs(p.y), 100)) this.event(p, 'milestone', { metres: Math.round(p.y) }); }
    if (Math.abs(p.floor) > of) { p.farthestFloor = p.floor; p.farthestAt = now; if (crossedDecade(of, Math.abs(p.floor), 10)) this.event(p, 'milestone', { floor: p.floor }); }
  }

  // ------------------------------------------------------------------ players: here, or in the store
  // Someone held here, or else their stored record (not held: adopt it to act on them).
  private lookup(r: PlayerRecord | null): Player | undefined {
    return r ? this.people.get(r.id) ?? fromStore(r) : undefined;
  }
  // The player with this id, held here: fetched from the store and held if need be.
  private held(id: string): Player | undefined {
    const hit = this.people.get(id); if (hit) return hit;
    const r = this.store.playerById(id);
    return r ? this.people.adopt(fromStore(r)) : undefined;
  }
  // A name nobody here has, nor anyone in the store (taken: instead, only those names, for the owner's reset).
  randomName(taken?: Set<string>) {
    const here = taken ?? this.people.names(), r = crypto.getRandomValues(new Uint32Array(20));
    const free = (n: string) => !here.has(n) && (taken !== undefined || !this.store.nameTaken(n));
    for (let i = 0; i < 16; i += 2) {
      const n = `${NAME_ADJ[r[i] % NAME_ADJ.length]} ${NAME_NOUN[r[i + 1] % NAME_NOUN.length]}`;
      if (free(n)) return n;
    }
    return `${NAME_ADJ[r[16] % NAME_ADJ.length]} ${NAME_NOUN[r[17] % NAME_NOUN.length]} ${2 + r[18] % 98}`;
  }
  private rename(p: Player, name: string, now: number) {   // the leaderboard shows finders by their current name
    const was = p.name; p.name = name; this.save(p, now);
    this.store.renamePlayer(p.id, name);
    this.boardCache = null; this.rosterCache = null;
    this.event(p, 'rename', { from: was, to: name });
  }
  // The player with this id, held here (fetched from the store if need be), or made. side: only for tests, and only
  // where ALLOW_SIDE_CHOICE is 1 (.dev.vars); everyone else gets the coin toss.
  private getOrCreate(id: string, kind: Kind, name: string, now: number, side?: unknown, secretHash: string | null = null): Player {
    let p = this.held(id);
    if (!p) {
      // newcomers arrive on either side, a coin toss each: two communities from the start
      const chosen = this.host.settings.ALLOW_SIDE_CHOICE === '1' && (side === 0 || side === 1) ? side : null;
      p = this.people.adopt({ id, kind, name, pubId: kind === 'agent' ? id : 'p_' + randomHex(8), secretHash, ...R.SPAWN, side: chosen ?? (Math.random() < 0.5 ? 0 : 1),
        updatedAt: now, farthestY: 0, farthestFloor: 0, farthestAt: null, booksOpened: 0, connected: false, fall: null });
      this.save(p, now); this.event(p, 'arrive', { name });
      if (this.counts) { this.counts.n++; if (kind === 'agent') this.counts.agents++; }
    }
    return p;
  }
  private save(p: Player, now: number) {
    p.updatedAt = now; p.savedAt = now;
    this.store.savePlayer(p);
    this.rosterRows?.set(p.id, p);
  }
  private event(p: Player | null, type: string, payload: unknown) {
    this.store.appendEvent(p?.pubId ?? null, type, payload);   // public: the public id
  }
  private setting(name: string, fallback: number) { return Number(this.host.settings[name]) || fallback; }
  // Whose socket this is: held here, or (a socket from before this wake whose player was let go) fetched again.
  playerOf(ws: S) {
    const hit = this.owners.get(ws); if (hit) return hit;
    const pid = this.sockets.attachment(ws)?.pid, p = pid ? this.held(pid) : undefined;
    if (!p) return undefined;
    this.people.connect(p); this.owners.set(ws, p);
    return p;
  }
  private send(ws: S, msg: unknown) { try { this.sockets.send(ws, JSON.stringify(msg)); } catch { /* socket closing */ } }
  private close(ws: S, code: number, reason: string) { try { this.sockets.close(ws, code, reason); } catch { /* already closing */ } }
  private take(key: string, perSecond: number, burst: number) {
    const now = this.host.now(), b = this.buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) / 1000 * perSecond); b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  }
  // The rate limit at each adapter's edge, by who is acting: a person 30 a second, an agent its key's rate a minute.
  // burst: 60 over a socket, 10 for an agent's MCP verbs (each of which may set them walking).
  private admit(p: Player, burst: number) { return this.take(p.id, p.kind === 'human' ? 30 : this.agentRate(p.id) / 60, burst); }
  private agentRate(pid: string) {
    const hit = this.rates.get(pid);
    if (hit !== undefined) return hit;
    const rate = this.store.agentRate(pid) ?? 60;
    this.rates.set(pid, rate);
    return rate;
  }

  // ------------------------------------------------------------------ leaderboard
  // Each side keeps its own board (the BOARD_KEEP longest finds made in its gallery); `top` is both together.
  // The default board (BOARD_SHOW a side) is what every welcome and claim reply carries: computed once per change.
  board(limit = BOARD_SHOW) {
    if (limit !== BOARD_SHOW) return this.boardNow(limit);
    return (this.boardCache ??= this.boardNow(BOARD_SHOW));
  }
  private boardNow(limit: number) {   // held by the store: no query once it has read the boards this wake
    const b = this.store.board(limit);
    const sides = [0, 1].map(sd => ({ name: SIDES[sd], min: b.mins[sd], top: b.sides[sd] }));
    return { top: b.top, min: Math.min(sides[0].min, sides[1].min), sides };
  }
  // Each claim is judged by the body's rules (well formed, rare enough, somewhere they could have read it: B.judgeClaim)
  // and then checked by scanning that one page here: only a real run at exactly that spot counts, and its text comes
  // from the scan, not from the claim. Returns, per claim, its rank or why not.
  claimFinds(p: Player, claims: unknown, now: number): ClaimResult[] {
    if (!Array.isArray(claims)) return [];
    const mins = this.store.boardMins(), out: ClaimResult[] = [];
    let changed = false;
    for (const c of claims.slice(0, CLAIMS_PER_MSG)) {
      const v = B.judgeClaim(p, c, mins, now);
      if (!v.ok) { out.push(v); continue; }
      const { address: a, side, page, at, len } = v.claim, min = mins[side];
      if (!this.take('claims:' + p.id, 1, 60)) { out.push({ ok: false, reason: 'rate limited' }); continue; }
      // already on the board: no need to read the page again (the first finder keeps it)
      const known = this.store.known({ side, floor: a.floor, unit: a.unit, shelf: a.shelf, slot: a.slot, page, at });
      const f = known && (len === undefined || known.len === len) ? known
        : scanPageOf(a, page, this.host.words, len === undefined ? min : len).find(x => x.at === at && (len === undefined || x.len === len));
      if (!f) { out.push({ ok: false, reason: 'no such find' }); continue; }
      const { first, rank, overall, finder } = this.store.claim({ side, floor: a.floor, unit: a.unit, shelf: a.shelf, slot: a.slot, page, at,
        len: f.len, words: f.words, text: f.text }, p.id, p.name, now);   // rank on its own side's board, and overall across both
      if (first) { changed = true; this.event(p, 'find', { address: { ...a, side }, page, at, text: f.text, rank, overall }); }
      out.push({ ok: true, first, rank, overall, side: SIDES[side], text: f.text, finder, address: { ...a, side }, page, at });
    }
    if (changed) {
      this.boardCache = null;
      this.store.trimBoard();
      this.scheduleBoard();
    }
    return out;
  }
  private scheduleBoard() {   // everyone gets the new board, at most every 2 s
    if (this.boardDue) return;
    this.boardDue = true;
    this.host.schedule(2000, () => {
      this.boardDue = false;
      const msg = Proto.W.board(this.board());
      for (const ws of this.sockets.list()) this.send(ws, msg);
    });
  }

  // ================================================================== the owner's operations (src/index.ts)
  // POST /api/admin/wipe {confirm: 'wipe'}: a fresh start. Every human player, find (and the archived boards of older
  // libraries), mark and event is deleted and every socket closed; agents and their keys stay, back at the spawn as
  // new. The books are never stored, so they are untouched. Cannot be undone.
  wipe() {
    const counts = this.playerCounts(); this.counts = null;
    const { finds, events, archives } = this.store.wipe(), before = { humans: counts.n - counts.agents, finds, events };
    const now = this.host.now();
    const reset = (p: Player) => {
      Object.assign(p, { x: R.SPAWN.x, y: R.SPAWN.y, floor: R.SPAWN.floor, yaw: R.SPAWN.yaw, fall: null, legs: undefined, reading: undefined,
        farthestY: 0, farthestFloor: 0, farthestAt: null, booksOpened: 0, trail: undefined, vx: 0, vy: 0 });
      this.save(p, now);
    };
    for (const p of [...this.people.all()]) { if (p.kind === 'human') this.people.remove(p.id); else reset(p); }
    const agents = this.store.allPlayers('agent');
    for (const r of agents) if (!this.people.get(r.id)) reset(fromStore(r));
    this.buckets.clear(); this.boardCache = null; this.rosterCache = null; this.rosterRows = null;
    this.owners = new WeakMap();   // so the sockets closing below don't write the people just deleted back
    for (const ws of this.sockets.list()) this.close(ws, 4001, 'reset');
    this.event(null, 'wipe', { humansDeleted: before.humans, findsDeleted: before.finds, eventsDeleted: before.events, archivesDropped: archives });
    return { deleted: before, archivesDropped: archives, agentsKept: agents.length };
  }
  // POST /api/admin/player {id: 'p_…', rename?: string, remove?: true}: moderation. rename gives them that name (or, if
  // it is empty or itself not allowed, a random one) and locks it, so their browser can't put the old one back; remove
  // deletes them, their finds and their marks, and closes their sockets: they come back, if at all, as a new person
  // (limited per address like anyone new).
  moderate(pubId: string, what: { rename?: string; remove?: boolean }) {
    const p = this.people.withPub(pubId) ?? this.lookup(this.store.playerByPub(pubId));
    if (!p || p.kind !== 'human') return { error: 'no such player' };
    const now = this.host.now(), name = p.name;
    for (const ws of this.sockets.list()) if (this.playerOf(ws)?.id === p.id) {
      if (what.remove) this.owners.delete(ws);   // so its close doesn't write them back
      this.close(ws, 4005, 'moderated');
    }
    if (what.remove) {
      const finds = this.store.removePlayer(p.id);
      if (this.counts) { this.counts.n--; if (!p.secretHash) this.counts.legacy--; }
      this.people.remove(p.id); this.rosterRows?.delete(p.id);
      this.boardCache = null; this.rosterCache = null;
      this.event(null, 'removed', { id: pubId, name, finds });
      return { removed: pubId, name, findsDeleted: finds };
    }
    if (typeof what.rename === 'string') {
      p.nameLocked = true; this.rename(p, cleanName(what.rename) || this.randomName(), now);
      return { renamed: pubId, from: name, to: p.name };
    }
    return { error: 'say rename or remove' };
  }
  private playerCounts() { return { ...(this.counts ??= this.store.playerCounts()) }; }
  // GET /api/admin/diag: the shape of the identity data, for checking a migration took, and the cost of things.
  diag(since = 0) {
    const d = this.store.diag(since), c = this.playerCounts(), now = this.host.now(), held = [...this.people.all()];
    return {
      players: { n: c.n, noPub: d.players.noPub, hPub: d.players.hPub, legacy: c.legacy },
      // who is held in memory: those present (and anyone in motion or just fetched), not everyone there has been
      inMemory: { n: held.length, present: held.filter(p => isPresent(p, now)).length, hPub: held.filter(p => p.pubId.startsWith('h_')).length },
      events: d.events,
      online: this.people.humansOnline, cap: this.maxHumans, sockets: this.sockets.list().length, usage: this.usageToday(),
      // names that appeared or changed since `since` (ms), as they are now, for the owner to look over
      names: d.names,
      // rows read and written by each store operation since this wake, and the migration this wake ran (if any)
      store: { migrated: this.store.migrated, ops: this.store.costsSinceWake() },
    };
  }
  // POST /api/admin/reset: new random names for every person, everyone back at the spawn with no farthest reach,
  // and/or an empty leaderboard. Agents keep the names their keys give them. Every socket is closed so each client
  // reconnects and hears its new name and place in its welcome. Reads and writes every player there has been.
  resetWorld(what: { names?: boolean; positions?: boolean; finds?: boolean }) {
    const now = this.host.now(), records = this.store.allPlayers(), before = { players: records.length, finds: this.store.findsCount() };
    const everyone = records.map(r => this.people.get(r.id) ?? fromStore(r));
    const taken = new Set<string>(what.names ? everyone.filter(p => p.kind !== 'human').map(p => p.name) : []);   // every person's name is freed
    for (const p of everyone) {
      if (what.names && p.kind === 'human') { p.name = this.randomName(taken); taken.add(p.name); this.store.setName(p.id, p.name); }
      if (what.positions) Object.assign(p, { x: R.SPAWN.x, y: R.SPAWN.y, floor: R.SPAWN.floor, yaw: R.SPAWN.yaw, side: 0, fall: null, legs: undefined,
        reading: undefined, farthestY: 0, farthestFloor: 0, farthestAt: null });
      this.save(p, now);
    }
    if (what.finds) { this.store.clearFinds(); this.boardCache = null; }
    this.rosterCache = null;
    this.event(null, 'reset', what);
    for (const ws of this.sockets.list()) this.close(ws, 4001, 'reset');
    return { before, reset: what, sockets: 'closed; clients reconnect' };
  }

  // ================================================================== RPC surface for the Worker (owner API + MCP)
  async mintAgent(name: string, ratePerMin: number, side?: unknown) {
    const key = 'ssa_' + hex(crypto.getRandomValues(new Uint8Array(24)));
    const id = 'a_' + hex(crypto.getRandomValues(new Uint8Array(6)));
    const now = this.host.now(), nm = cleanName(name) || 'agent';
    this.store.addAgentKey(await sha256(key), id, nm, Math.max(1, Math.min(600, Math.floor(ratePerMin) || 60)), now);
    this.getOrCreate(id, 'agent', nm, now, side);
    return { id, name: nm, key };
  }
  listAgents() {
    return this.store.listAgentKeys();
  }
  revokeAgent(id: string) {
    this.rates.delete(id);
    return this.store.revokeAgentKey(id);
  }
  async authAgent(key: string): Promise<{ id: string; name: string } | null> {
    if (!/^ssa_[0-9a-f]{48}$/.test(key)) return null;
    const r = this.store.agentByKeyHash(await sha256(key));
    if (!r) return null;
    this.getOrCreate(r.id, 'agent', r.name, this.host.now());
    return r;
  }
  map() { this.count('requests'); return { night: this.night(), players: this.roster(this.host.now()) }; }
  events(since: number, limit: number) {
    this.count('requests');
    return this.store.eventsSince(since, limit);
  }
  leaderboard(limit: number) { this.count('requests'); return this.board(Math.max(1, Math.min(BOARD_KEEP, Math.floor(limit) || BOARD_SHOW))); }

  // Agent verbs. Each returns plain data; the MCP layer words it.
  private agentBegin(id: string, verb: string, free = false) {
    this.count('requests');
    const p = this.held(id);
    if (!p) throw new Error('unknown agent');
    if (!free && !this.admit(p, 10)) throw new Error('rate limited; slow down');
    const now = this.host.now(), pos = this.pos(p, now);
    p.lastActAt = now;
    const moving = verb !== 'look' && verb !== 'map' && verb !== 'finds' && verb !== 'claim';
    const why = moving ? B.busy(p, now, this.night(now).nextAt) : null;
    if (why) throw new Error(why);
    return { p, now, pos };
  }

  // MCP: the board, what a find needs to place, and the known finds around you
  agentFinds(id: string) {
    const { p, pos } = this.agentBegin(id, 'finds'), b = this.board(), u = Math.floor(pos.y), mine = b.sides[p.side], theirs = b.sides[1 - p.side];
    const tagged = (f: Record<string, unknown>) => ({ text: f.text, side: SIDES[f.side as number], floor: f.floor, unit: f.unit, shelf: (f.shelf as number) + 1,
      book: (f.slot as number) + 1, page: f.page, at: f.at, len: f.len, finder: f.finder, ...(f.agent ? { agent: true } : {}) });
    // your side and floor only, like the page's finder: another floor's words are found by going there
    const near = this.store.findsNear(p.side, pos.floor, u - 200, u + 200, 20)
      .map(f => ({ ...tagged(f), metresAway: round2((f.unit as number) + 0.5 - pos.y) }));
    return { you: { side: SIDES[p.side], floor: pos.floor, metresAlong: round2(pos.y) }, claimNeeds: `${mine.min}+ characters`, near,
      board: mine.top.map(tagged), acrossTheShaft: { side: theirs.name, top: theirs.top.slice(0, 10).map(tagged) }, bothSides: b.top.slice(0, 10).map(tagged) };
  }
  // Finds as agents name them (B.AgentClaim: shelf and book from 1, the side by name, their own if left out).
  agentClaim(id: string, finds: AgentClaim[]): ClaimResult[] {
    const { p, now } = this.agentBegin(id, 'claim');
    return this.claimFinds(p, finds.map(f => ({ address: B.addressOf(f, p.side), page: f.page, at: f.at, len: f.len })), now);
  }

  agentLook(id: string, afterTravel = false) {
    const { p, now, pos } = this.agentBegin(id, 'look', afterTravel);
    const up = nearestStairFoot(pos.y), down = nearestStairFoot(pos.y - STAIR_LEN) + STAIR_LEN;
    // other people nearby, under the LOOK rule: their own side only (src/population.ts)
    const peers = this.snapshot(now).within(LOOK, { side: p.side, floor: pos.floor, y: pos.y }, p.pubId).map(e => e.person);
    const unit = Math.floor(pos.y);
    const marks = pos.state === 'falling' ? [] : this.marksNear(p.side, pos.floor, pos.y, 0, 10);
    const { n, nextAt } = this.night(now);
    this.scheduleFlush();
    return {
      you: { name: p.name, side: SIDES[p.side], floor: pos.floor, metresAlong: round2(pos.y), state: pos.state, booksOpened: p.booksOpened,
        reading: p.reading ? { address: R.describeAddress(p.reading.addr), page: p.reading.page } : null },
      shelvesHere: pos.state === 'falling' ? null : { unit, shelves: SHELVES, booksPerShelf: SLOTS },
      stairs: { upFootAt: up, downOpeningAt: down },
      night: { n, endsInS: Math.round((nextAt - now) / 1000) },
      peers, marks,
    };
  }

  agentWalk(id: string, metres: number, run: boolean) {
    const { p, now, pos } = this.agentBegin(id, 'walk');
    if (!isFinite(metres) || metres === 0) throw new Error('metres must be a non-zero number');
    const trip = B.planWalk(pos, metres, run, now, MAX_ACT_S);
    this.travel(p, trip, now);
    return { arriveAt: trip.arriveAt, metres: trip.metres, truncated: trip.metres !== metres };
  }

  agentClimb(id: string, where: 'up' | 'down' | 'railing') {
    const { p, now, pos } = this.agentBegin(id, 'climb');
    const trip = B.planClimb(pos, where, now);
    if (trip.fallAt === undefined) this.travel(p, trip, now);
    else {   // over the railing: no trail (nothing on a shelf is read from mid-air)
      p.legs = trip.legs; this.settle(p, trip.to, now);
      p.fall = { t0: trip.fallAt, floor: pos.floor };
      this.save(p, now); this.event(p, 'fall', { floor: pos.floor, y: pos.y });
    }
    return { arriveAt: trip.arriveAt, where };
  }

  // Set out: the legs for onlookers, the trail for claims, and the destination kept at once.
  private travel(p: Player, trip: B.Trip, now: number) {
    p.legs = trip.legs;
    for (const l of trip.legs) p.trail = B.track(p.trail, B.stretch(p.side, l.floor, l.y0, l.y1, l.t0, l.t1), now);
    this.settle(p, trip.to, now);
  }
  private settle(p: Player, to: { x: number; y: number; floor: number }, now: number) {
    // Persist the destination now; the legs only exist to interpolate the trip for onlookers.
    p.x = to.x; p.y = to.y; p.floor = to.floor; p.reading = undefined;
    this.farthest(p, now); this.save(p, now); this.scheduleFlush();
  }

  // Shelf and book from 1, in the unit they stand at or name, on their own floor and side: they step up to the
  // shelf to take it down (people over a socket walk there themselves).
  agentOpen(id: string, shelf: number, book: number, unit?: number) {
    const { p, now, pos } = this.agentBegin(id, 'open');
    const addr = B.addressOf({ floor: pos.floor, unit: unit ?? Math.floor(pos.y), shelf, book }, p.side);
    if (!Proto.isAddress(addr)) throw new Error(`shelf is 1-${SHELVES}, book is 1-${SLOTS}`);
    const r = this.openBook(p, addr, now, true);
    if (!r.ok) throw new Error(r.reason);
    return this.pageOf(p, now);
  }

  agentPage(id: string, n: number) {
    const { p, now } = this.agentBegin(id, 'page');
    const r = this.turnPage(p, n);
    if (!r.ok) throw new Error(r.reason);
    return this.pageOf(p, now);
  }

  private pageOf(p: Player, now: number) {
    const r = p.reading!;
    const marks = this.marksNear(Proto.sideOf(r.addr), r.addr.floor, r.addr.unit, 0, 0).filter(m => m.shelf === r.addr.shelf && m.slot === r.addr.slot);
    return { address: R.describeAddress(r.addr), page: r.page, of: PAGES, text: pageText(r.addr, r.page), marks, at: now };
  }

  // Agents mark the book they hold (their interface names no address); its reach is judged as anyone's.
  agentMark(id: string, kind: MarkKind) {
    const { p, now } = this.agentBegin(id, 'mark');
    if (!p.reading) throw new Error('open the book you want to mark first');
    const r = this.addMark(p, p.reading.addr, kind, now);
    if (!r.ok) throw new Error(r.reason);
    return r.mark;
  }
}

// ------------------------------------------------------------------ helpers
// A stored player as held: not connected until a socket here says so.
function fromStore(r: PlayerRecord): Player { return { ...r, connected: false }; }
// A name others will see: no control characters, no invisible or direction-flipping ones (zero-width, bidi overrides,
// soft hyphen, BOM), no angle brackets, spaces collapsed, at most 32 characters, at least one letter or digit, and no
// slurs (src/blocklist.ts).
export function cleanName(n: unknown) {
  if (typeof n !== 'string') return '';
  const s = Array.from(n.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>]/g, '')
    .replace(/\s+/g, ' ').trim()).slice(0, 32).join('').trim();
  return /[\p{L}\p{N}]/u.test(s) && !blocked(s) ? s : '';
}
// Default names for people who don't choose one: 40 × 40 pairs in the novel's key, like "Patient Scribe".
const NAME_ADJ = ['Patient', 'Weary', 'Quiet', 'Restless', 'Gentle', 'Stubborn', 'Hopeful', 'Wistful', 'Solemn', 'Curious',
  'Tireless', 'Faithful', 'Humble', 'Lonely', 'Dusty', 'Drowsy', 'Earnest', 'Idle', 'Lucid', 'Meek', 'Pale', 'Placid',
  'Steady', 'Stoic', 'Sober', 'Silent', 'Slow', 'Sleepless', 'Sunless', 'Tender', 'Watchful', 'Wakeful', 'Careful', 'Calm',
  'Hushed', 'Grave', 'Hollow', 'Gray', 'Wry', 'Devout'];
const NAME_NOUN = ['Reader', 'Scribe', 'Pilgrim', 'Clerk', 'Cataloguer', 'Binder', 'Archivist', 'Lamplighter', 'Copyist', 'Seeker',
  'Walker', 'Climber', 'Scholar', 'Indexer', 'Bookworm', 'Stranger', 'Penitent', 'Traveller', 'Sojourner', 'Lodger', 'Guest',
  'Tenant', 'Drifter', 'Hermit', 'Novice', 'Keeper', 'Sexton', 'Porter', 'Reckoner', 'Cartographer', 'Collector', 'Gleaner',
  'Listener', 'Pedant', 'Speller', 'Browser', 'Mourner', 'Dreamer', 'Watcher', 'Counter'];
const round2 = (v: number) => Math.round(v * 100) / 100;
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
function randomHex(bytes: number) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function sha256(s: string) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }
function crossedDecade(before: number, after: number, min: number) {
  if (after < min) return false;
  return Math.floor(Math.log10(after)) > Math.floor(Math.log10(Math.max(before, 1)));
}
