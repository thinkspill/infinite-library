// One connection to the world, and what it knows: the page's multiplayer, and the scripts' clients (smoke, attack,
// load), all on one implementation of the protocol (web/protocol.js). It holds the socket and its state — you (the
// welcome's person), the night, the leaderboard, the people around you and the roster as received, tonight's marks —
// and the client's pacing: when a move report is due, the claim queue (the best 8 every 5 s, none under the board's
// minimum), reconnecting (backing off to 30 s; 120 s when the world is full; never once another tab took over), and a
// fresh secret when the world hands one out (rekey). It writes into no player, scene or DOM: it emits what changed,
// and the page (or a script) applies it.
//
// Everything with a side effect is passed in — the WebSocket constructor, the clock, the timers, the storage — so it
// runs the same in a browser, in Node (which has a global WebSocket), and against a fake socket and clock
// (scripts/check-session.ts).
//
// Plain JS like protocol.js: no DOM, no Node.
import * as Proto from './protocol.js';
import { EXTRAPOLATE_S } from './geometry.js';

export const CLAIM_EVERY_S = 5, CLAIMS_PER_SEND = 8, CLAIM_QUEUE = 64;
export const BACKOFF_MAX_MS = 30000, FULL_RETRY_MS = 120000;
const ANON = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The player as the page has them, for deciding when the world should hear of it.
 * @typedef {{ x: number, y: number, floor: number, side: number, yaw: number, vx: number, vy: number, reading?: boolean }} Body
 * @typedef {ReturnType<typeof Proto.move> & { at: number }} Report   a move as sent, and when (ms, the session's clock)
 */

/**
 * Whether a move report is due: where you are going, not where you are. Due when your course changes (started,
 * stopped, a floor, a side, over the railing or back, a book opened or closed), when the world's guess (the last report
 * carried forward, for at most EXTRAPOLATE_S) is half a metre out, when your velocity changes by 0.4 m/s, when you
 * look a good way round, and otherwise every 2 s while moving, every 5 s while still. Velocities under 5 cm/s are 0.
 * @param {Body} b  @param {Report | null} last  @param {number} now  ms, the clock last.at was taken on
 */
export function moveDue(b, last, now) {
  const L = last, vx = Math.abs(b.vx) < 0.05 ? 0 : b.vx, vy = Math.abs(b.vy) < 0.05 ? 0 : b.vy, reading = !!b.reading;
  if (!L || L.floor !== b.floor || L.side !== b.side || !!L.reading !== reading || (L.x > 0) !== (b.x > 0) || (!!(L.vx || L.vy) !== !!(vx || vy))) return true;
  const t = Math.min(EXTRAPOLATE_S, (now - L.at) / 1000), err = Math.hypot(L.x + (L.vx || 0) * t - b.x, L.y + (L.vy || 0) * t - b.y);
  const turn = Math.abs(Math.atan2(Math.sin(b.yaw - L.yaw), Math.cos(b.yaw - L.yaw)));
  return err > 0.5 || Math.hypot(vx - (L.vx || 0), vy - (L.vy || 0)) > 0.4 || (turn > 0.35 && now - L.at > 500) || now - L.at > (vx || vy ? 2000 : 5000);
}
/** The move to report for a body (velocities under 5 cm/s sent as 0). @param {Body} b */
export const moveOf = b => Proto.move({ x: b.x, y: b.y, floor: b.floor, side: b.side, yaw: b.yaw,
  vx: Math.abs(b.vx) < 0.05 ? 0 : b.vx, vy: Math.abs(b.vy) < 0.05 ? 0 : b.vy, reading: !!b.reading });

/** A storage in memory, for scripts: the same get/set as the page's localStorage wrapper. @param {Record<string, string>} [init] */
export function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (/** @type {string} */ k) => m.get(k) ?? null, set: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, String(v)); } };
}

/**
 * @param {{
 *   url: string,                                   ws(s)://host/ws
 *   WebSocket?: any,                               the constructor (default: the global one)
 *   wsOptions?: any,                               its second argument (Node: { headers })
 *   storage?: { get(k: string): string | null, set(k: string, v: string): void },   'anon' and 'name' live here
 *   now?: () => number,                            ms, monotonic (default performance.now)
 *   setTimeout?: (f: () => void, ms: number) => any, clearTimeout?: (t: any) => void,
 *   randomBytes?: (n: number) => Uint8Array,       for a new secret (default crypto.getRandomValues)
 *   hello?: false | { side?: number },             extra hello fields; false: say no hello at all (attack.ts)
 *   reconnect?: boolean,                           default true
 *   paused?: () => boolean,                        while true, nothing is sent (the page while teleported away)
 *   warn?: (...a: unknown[]) => void,
 * }} o
 */
export function createSession(o) {
  const WS = o.WebSocket ?? globalThis.WebSocket, storage = o.storage ?? memoryStorage();
  const now = o.now ?? (() => performance.now()), later = o.setTimeout ?? ((f, ms) => setTimeout(f, ms)), cancel = o.clearTimeout ?? (t => clearTimeout(t));
  const randomBytes = o.randomBytes ?? (n => crypto.getRandomValues(new Uint8Array(n)));
  const paused = o.paused ?? (() => false), warn = o.warn ?? ((...a) => console.warn('[net]', ...a));
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  let retry = 0, sendT = 0, claimT = 0, timer = /** @type {any} */ (null), stopped = false;
  const claimed = new Set();

  const s = {
    /** @type {any} */ ws: null,
    online: false, replaced: false, full: false,
    /** @type {Proto.Person | null} */ you: null, /** @type {number | null} */ night: null, nextAt: 0,
    /** @type {Proto.Board | null} */ board: null, /** @type {Proto.Person[]} */ peers: [], /** @type {Proto.RosterEntry[]} */ roster: [],
    /** @type {Map<number, Proto.MarkRow>} */ marks: new Map(),
    /** @type {any[]} */ claims: [],
    /** @type {Report | null} */ lastSent: null,
    get others() { return this.peers.length; },
    get retry() { return retry; },

    /**
     * Listen: 'open' (socket open), 'online' (on: boolean), 'welcome' (m, { nameChanged }), 'correct', 'peers', 'roster',
     * 'board' (board), 'found', 'marks' (the marks map), 'marked', 'night', 'replaced', 'rekey', 'full', 'error' (each
     * with its message), 'message' (every message, after the above), 'close' (code, wait ms or null: no retry).
     * Returns a function that stops listening.
     * @param {string} type @param {Function} fn
     */
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn); return () => listeners.get(type).delete(fn);
    },
    /** @param {string} type @param {...unknown} a */
    emit(type, ...a) { for (const fn of listeners.get(type) ?? []) fn(...a); },

    /** This browser's secret: kept in storage, made when there is none. */
    anon() {
      let a = storage.get('anon');
      if (!a || !ANON.test(a)) { a = Array.from(randomBytes(12), b => b.toString(16).padStart(2, '0')).join(''); storage.set('anon', a); }
      return a;
    },
    name() { return storage.get('name') || ''; },

    connect() {
      stopped = false; cancel(timer); timer = null;
      const ws = new WS(o.url, o.wsOptions);
      s.ws = ws;
      ws.onopen = () => {
        retry = 0;
        if (o.hello !== false) ws.send(Proto.encode(Proto.hello({ anon: s.anon(), name: s.name(), ...(o.hello || {}) })));
        s.emit('open');
      };
      ws.onmessage = (/** @type {{ data: unknown }} */ e) => {
        const r = Proto.read(String(e.data));   // typed, defaults filled in; or why not, and the frame is dropped
        if (!r.ok) { warn('unreadable message:', r.reason); return; }
        try { s.handle(r.msg); } catch (err) { warn(err); }
      };
      ws.onclose = (/** @type {{ code?: number }} */ e) => {
        if (s.ws !== ws) return;
        s.ws = null; s.setOnline(false);
        let wait = null;
        if (!s.replaced && !stopped && o.reconnect !== false) {
          wait = s.full ? FULL_RETRY_MS : Math.min(BACKOFF_MAX_MS, 1000 * 2 ** retry++); s.full = false;   // a crowded night: try again in a while
          timer = later(() => { timer = null; if (!stopped) s.connect(); }, wait);
        }
        s.emit('close', e && e.code, wait);
      };
      ws.onerror = () => s.emit('socketError');
      return s;
    },
    /** Drop the socket and connect again (backing off as after any close): a new name, say. */
    restart() { if (s.ws) try { s.ws.close(); } catch (e) { /* reconnects anyway */ } },
    /** Close for good: no more reconnecting. */
    close() { stopped = true; cancel(timer); timer = null; if (s.ws) try { s.ws.close(); } catch (e) { /* closed */ } },

    /** @param {boolean} on */
    setOnline(on) {
      s.online = on;
      if (!on) s.peers = [];
      s.emit('online', on);
    },
    /** Send a message, once welcomed (and not paused). @param {object} m */
    send(m) { if (s.ws && s.online && !paused()) try { s.ws.send(Proto.encode(m)); } catch (e) { /* reconnecting */ } },
    /** Send a frame as is, welcomed or not: a string goes as written, anything else as JSON (attack.ts). @param {unknown} m */
    sendRaw(m) { if (s.ws) s.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); },

    /** @param {Proto.ServerMsg} m  a message from the world, as Proto.read() returns it */
    handle(m) {
      switch (m.t) {
        case 'welcome': {
          s.you = m.you; s.night = m.night; s.nextAt = m.nextAt; s.board = m.board; s.lastSent = null;
          // a given name shows until you choose your own; and if the world changed the one you chose (cleaned it, or
          // refused it), you keep the name others see
          const had = s.name(), nameChanged = !had || had !== m.you.name;
          if (had && had !== m.you.name) storage.set('name', m.you.name);
          s.setOnline(true);
          s.emit('welcome', m, { nameChanged });
          break;
        }
        case 'correct': s.emit('correct', m); break;
        case 'peers': s.peers = m.peers; s.emit('peers', m.peers); break;
        case 'roster': s.roster = m.players; s.emit('roster', m.players); break;
        case 'board': s.board = m.board; s.emit('board', m.board); break;
        case 'found': s.board = m.board; s.emit('board', m.board); s.emit('found', m); break;
        case 'marks': if (m.replace) s.marks.clear(); for (const k of m.marks) s.marks.set(k.id, k); s.emit('marks', s.marks); break;
        case 'mark': s.marks.set(m.mark.id, m.mark); s.emit('marks', s.marks); break;
        case 'marked': s.emit('marked', m); break;
        case 'night': s.night = m.n; s.nextAt = m.nextAt; s.marks.clear(); s.emit('marks', s.marks); s.emit('night', m); break;
        case 'replaced': s.replaced = true; s.emit('replaced', m); break;
        case 'rekey': storage.set('anon', m.anon); s.emit('rekey', m); break;   // a fresh secret: the old one stops working
        case 'full': s.full = true; s.emit('full', m); break;
        case 'error': s.emit('error', m); break;
      }
      s.emit('message', m);
    },

    /**
     * Finds the finder turned up: those that would place on their side's board (and weren't offered before) join the
     * queue, longest first, at most CLAIM_QUEUE. The world checks each and credits the first to claim it.
     * @param {Array<{ side?: number, floor: number, unit: number, shelf: number, slot: number, page: number, at: number, len: number }>} finds
     */
    offer(finds) {
      if (!s.online || !s.board) return;
      for (const f of finds) {
        const k = `${f.side || 0}/${f.floor}/${f.unit}/${f.shelf}/${f.slot}/${f.page}/${f.at}`, need = Proto.boardMin(s.board, f.side);
        if (f.len < need || claimed.has(k)) continue;
        claimed.add(k); s.claims.push(f);
      }
      s.claims.sort((a, b) => b.len - a.len); s.claims.length = Math.min(s.claims.length, CLAIM_QUEUE);
    },

    /**
     * Each frame: the claims when due, and a move report when due (looked at ten times a second, under one a second
     * in practice). Returns the move sent, if any.
     * @param {number} dt  seconds since the last tick  @param {Body} body  where the player is now
     */
    tick(dt, body) {
      // nothing goes out while paused (away after a teleport): claims stay queued for coming home, not sent into a void
      if (!s.online || paused()) return null;
      claimT += dt;
      if (claimT > CLAIM_EVERY_S && s.claims.length) {   // the best few every 5 s: the world reads each claimed page
        claimT = 0;
        s.send(Proto.finds(s.claims.splice(0, CLAIMS_PER_SEND).map(Proto.claim)));
      }
      // at most 10 reports a second, except a change of world: into or out of the shaft, or across it. Those go at once,
      // so the world never misses a landing between two samples (it ends the fall: one crossing a fall, src/body.ts)
      const L = s.lastSent, changed = !L || (L.x > 0) !== (body.x > 0) || L.side !== body.side || L.floor !== body.floor;
      sendT += dt; if (sendT < 0.1 && !changed) return null; sendT = 0;
      const t = now();
      if (!moveDue(body, s.lastSent, t)) return null;
      const m = moveOf(body);
      s.lastSent = { ...m, at: t }; s.send(m);
      return m;
    },
  };
  return s;
}
