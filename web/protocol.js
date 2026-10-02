// The wire protocol between the page (and any other client: scripts/smoke.ts, attack.ts, load.ts) and the world
// (src/world.ts), over one WebSocket at /ws carrying JSON text frames. Every message is an object with a type `t`.
//
// Client → world: builders (hello, move, …) make each message, and decode() + validate() read one the way the world
// does: what it accepts, what it quietly ignores, and the reason it gives when it refuses. World → client: the same
// again the other way: builders (W.welcome, W.peers, …) the world sends with, and read(), which turns a frame into a
// typed message with defaults filled in, or a reason it can't be read (session.js logs it and drops the frame).
//
// Plain JS shared by the page and the Worker, like babel.js and scan.js: no DOM, no Node, no state.
import { PAGES, LINES, COLS, SHELVES, SLOTS } from './babel.js';
import { WALK, RUN } from './geometry.js';

export const MAX_MSG = 4096;            // characters: anything longer, or not text, is refused unread
export const CLAIMS_PER_MSG = 16;       // a finds message is read this far; the rest are dropped unanswered
export const MAX_CLAIM_LEN = LINES * COLS;
const ANON = /^[A-Za-z0-9_-]{8,64}$/;   // the secret a browser logs in with (kept in its localStorage)

/** Client → world message types. */
export const C = Object.freeze({
  hello: 'hello', move: 'move', open: 'open', page: 'page', close: 'close', mark: 'mark', map: 'map', finds: 'finds', ping: 'ping',
});
/** World → client message types. */
export const S = Object.freeze({
  welcome: 'welcome', correct: 'correct', peers: 'peers', roster: 'roster', board: 'board', found: 'found', marks: 'marks',
  mark: 'mark', marked: 'marked', night: 'night', replaced: 'replaced', rekey: 'rekey', full: 'full', error: 'error', pong: 'pong',
});

/** Why the world refuses a message, word for word as it says so in an error ({t: 'error', for?, reason}). */
export const REASON = Object.freeze({
  tooLarge: 'message too large',
  badJson: 'bad json',
  helloFirst: 'say hello first',             // then the socket is closed, 4003
  rateLimited: 'rate limited',
  needAnon: 'need anon id or token',         // for: 'hello'
  badAddress: 'bad address',                 // for: 'open' | 'mark'
  notesGone: 'notes are gone: you can leave the book standing open (open_book)',   // for: 'mark'
  kindOpenBook: 'kind must be open_book',    // for: 'mark'
  badClaim: 'bad claim',                     // in a found result
  /** @param {unknown} t */
  unknownType: t => `unknown message type ${String(t)}`,
});

// ------------------------------------------------------------------ shared shapes

/**
 * A book's place. side: 0 east, 1 west (missing means 0); shelf 0..5 and slot 0..31 count from 0.
 * @typedef {{ floor: number, unit: number, side?: number, shelf: number, slot: number }} Address
 */
/**
 * A claim to the leaderboard: a run of English at character `at` of `page`, `len` characters long (agents may
 * leave len out: then it is whatever run starts there).
 * @typedef {{ address: Address, page: number, at: number, len?: number }} Claim
 */

/** @param {{ side?: unknown }} a @returns {0 | 1} */
export const sideOf = a => (a && a.side === 1 ? 1 : 0);

/** The world's test for an address (the world uses this one too). @param {unknown} a @returns {a is Address} */
export function isAddress(a) {
  if (!a || typeof a !== 'object') return false;
  const b = /** @type {Record<string, unknown>} */ (a);
  return Number.isSafeInteger(b.floor) && Number.isSafeInteger(b.unit)
    && Number.isInteger(b.shelf) && /** @type {number} */ (b.shelf) >= 0 && /** @type {number} */ (b.shelf) < SHELVES
    && Number.isInteger(b.slot) && /** @type {number} */ (b.slot) >= 0 && /** @type {number} */ (b.slot) < SLOTS
    && (b.side === undefined || b.side === 0 || b.side === 1);
}

// ------------------------------------------------------------------ client → world: builders

/** Just the address's fields, side made explicit. @param {Address} a @returns {Required<Address>} */
export const address = a => ({ floor: a.floor, unit: a.unit, side: sideOf(a), shelf: a.shelf, slot: a.slot });

/**
 * A claim from a find as the finder reports it (its address flat, with page, at and len).
 * @param {Address & { page: number, at: number, len?: number }} f @returns {Claim}
 */
export const claim = f => ({ address: address(f), page: f.page, at: f.at, ...(f.len === undefined ? {} : { len: f.len }) });

/**
 * The first message: a browser logs in with its secret (anon), an agent with its key (token). name: what to be
 * called (the world cleans it, and picks one when it is empty or refused). side: honoured only by a dev world
 * (ALLOW_SIDE_CHOICE), for tests.
 * @param {{ anon?: string, token?: string, name?: string, side?: number }} o
 */
export function hello(o) {
  /** @type {{ t: 'hello', anon?: string, token?: string, name?: string, side?: number }} */
  const m = { t: 'hello' };
  if (o.token !== undefined) m.token = o.token;
  if (o.anon !== undefined) m.anon = o.anon;
  if (o.name) m.name = o.name;
  if (o.side !== undefined) m.side = o.side;
  return m;
}

/**
 * Where you are and where you are going (velocity in m/s), sent when your course changes and every few seconds.
 * Position and yaw are sent to the millimetre, velocity to the cm/s. side defaults to the one the world has for you.
 * @param {{ x: number, y: number, floor: number, yaw: number, side?: number, vx?: number, vy?: number, reading?: boolean }} o
 */
export function move(o) {
  /** @type {{ t: 'move', x: number, y: number, floor: number, yaw: number, side?: number, vx?: number, vy?: number, reading?: boolean }} */
  const m = { t: 'move', x: r3(o.x), y: r3(o.y), floor: o.floor, yaw: r3(o.yaw) };
  if (o.side !== undefined) m.side = o.side;
  if (o.vx !== undefined) m.vx = r2(o.vx);
  if (o.vy !== undefined) m.vy = r2(o.vy);
  if (o.reading !== undefined) m.reading = !!o.reading;
  return m;
}
const r3 = (/** @type {number} */ v) => +v.toFixed(3), r2 = (/** @type {number} */ v) => +v.toFixed(2);

/** Take a book down (the world checks you can reach it). @param {Address} a */
export const open = a => ({ t: /** @type {'open'} */ ('open'), address: address(a) });
/** Turn to page n of the book you hold. @param {number} n */
export const page = n => ({ t: /** @type {'page'} */ ('page'), n });
/** Put the book back. */
export const close = () => ({ t: /** @type {'close'} */ ('close') });
/** Leave a book standing open (the only mark there is). @param {Address} a */
export const mark = a => ({ t: /** @type {'mark'} */ ('mark'), address: address(a), kind: /** @type {'open_book'} */ ('open_book') });
/** Ask for the roster, for the map (answered at most every 2 s). */
export const map = () => ({ t: /** @type {'map'} */ ('map') });
/** Claim finds for the leaderboard (only the first CLAIMS_PER_MSG are read). @param {Claim[]} claims */
export const finds = claims => ({ t: /** @type {'finds'} */ ('finds'), finds: claims });
/** A round trip: the world answers pong, echoing at0. @param {number} [at0] */
export const ping = at0 => (at0 === undefined ? { t: /** @type {'ping'} */ ('ping') } : { t: /** @type {'ping'} */ ('ping'), at0 });

/** The text of a message, as sent. @param {object} m */
export const encode = m => JSON.stringify(m);

// ------------------------------------------------------------------ client → world: reading them as the world does

/**
 * @typedef {{ ok: true, msg: Record<string, unknown> }} Decoded
 * @typedef {{ ok: false, reason: string | null }} Undecoded   reason null: not an object, ignored without a word
 */
/**
 * A frame off the socket, before anything else: too large (or binary), not JSON, or not an object.
 * @param {unknown} raw @returns {Decoded | Undecoded}
 */
export function decode(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MSG) return { ok: false, reason: REASON.tooLarge };
  let m;
  try { m = JSON.parse(raw); } catch { return { ok: false, reason: REASON.badJson }; }
  if (!m || typeof m !== 'object') return { ok: false, reason: null };
  return { ok: true, msg: m };
}

/**
 * @typedef {{ t: 'hello', token: string } | { t: 'hello', anon: string, name: unknown, side: unknown }} Hello
 *   name is cleaned by the world (src/world.ts cleanName); side is honoured only by a dev world
 * @typedef {{ t: 'move', x: number, y: number, floor: number, yaw: number, side: 0 | 1 | undefined, vx: number, vy: number, reading: boolean }} Move
 *   side undefined: the side the world has for you; vx, vy: 0 when missing or not finite (the world caps them)
 * @typedef {{ t: 'open', address: Required<Address> }} Open
 * @typedef {{ t: 'page', n: number }} Page   n clamped to 1..PAGES
 * @typedef {{ t: 'close' }} Close
 * @typedef {{ t: 'mark', address: Required<Address>, kind: 'open_book' }} Mark
 * @typedef {{ t: 'map' }} MapAsk
 * @typedef {{ ok: true, claim: { address: Required<Address>, page: number, at: number, len: number | undefined } } | { ok: false, reason: string }} ClaimCheck
 * @typedef {{ t: 'finds', finds: ClaimCheck[] }} Finds   each claim checked in turn; a bad one answered 'bad claim' in place
 * @typedef {{ t: 'ping', at0: number | undefined }} Ping
 * @typedef {Hello | Move | Open | Page | Close | Mark | MapAsk | Finds | Ping} ClientMsg
 */
/**
 * @typedef {{ ok: true, msg: ClientMsg }} Valid
 * @typedef {{ ok: false, reason: string | null, for?: string }} Invalid
 *   reason null: ignored without a word (a nonsense move, a page that isn't a number); otherwise the world answers
 *   { t: 'error', for, reason } (for is left out for an unknown type)
 */
/**
 * One decoded message, checked the way the world reads it. What it doesn't check is the world's to judge: whether
 * you said hello first, the rate, a key or secret, reach, speed, and whether a find is real.
 * @param {Record<string, unknown>} m @returns {Valid | Invalid}
 */
export function validate(m) {
  switch (m.t) {
    case 'hello':
      if (typeof m.token === 'string') return { ok: true, msg: { t: 'hello', token: m.token } };
      if (typeof m.anon === 'string' && ANON.test(m.anon)) return { ok: true, msg: { t: 'hello', anon: m.anon, name: m.name, side: m.side } };
      return { ok: false, for: 'hello', reason: REASON.needAnon };
    case 'move': {
      const { x, y, floor, yaw } = m, side = m.side;
      if (typeof x !== 'number' || typeof y !== 'number' || typeof yaw !== 'number' || !Number.isSafeInteger(floor)
          || !isFinite(x) || !isFinite(y) || !isFinite(yaw) || Math.abs(y) > 1e12 || (side !== undefined && side !== 0 && side !== 1)) return { ok: false, reason: null };
      const v = (/** @type {unknown} */ u) => (typeof u === 'number' && isFinite(u) ? u : 0);
      return { ok: true, msg: { t: 'move', x, y, floor: /** @type {number} */ (floor), yaw, side: /** @type {0 | 1 | undefined} */ (side), vx: v(m.vx), vy: v(m.vy), reading: !!m.reading } };
    }
    case 'open':
      if (!isAddress(m.address)) return { ok: false, for: 'open', reason: REASON.badAddress };
      return { ok: true, msg: { t: 'open', address: address(m.address) } };
    case 'page':
      if (!Number.isInteger(m.n)) return { ok: false, reason: null };
      return { ok: true, msg: { t: 'page', n: Math.max(1, Math.min(PAGES, /** @type {number} */ (m.n))) } };
    case 'close': return { ok: true, msg: { t: 'close' } };
    case 'mark': {
      const why = markProblem(m.address, m.kind);
      if (why) return { ok: false, for: 'mark', reason: why };
      return { ok: true, msg: { t: 'mark', address: address(/** @type {Address} */ (m.address)), kind: 'open_book' } };
    }
    case 'map': return { ok: true, msg: { t: 'map' } };
    case 'finds':
      return { ok: true, msg: { t: 'finds', finds: Array.isArray(m.finds) ? m.finds.slice(0, CLAIMS_PER_MSG).map(checkClaim) : [] } };
    case 'ping': return { ok: true, msg: { t: 'ping', at0: typeof m.at0 === 'number' ? m.at0 : undefined } };
    default: return { ok: false, reason: REASON.unknownType(m.t) };
  }
}

/** Why a mark can't be left, before reach is considered: null when it can. @param {unknown} a @param {unknown} kind */
export function markProblem(a, kind) {
  if (!isAddress(a)) return REASON.badAddress;
  if (kind === 'note') return REASON.notesGone;   // notes (free text others read) were removed before launch
  if (kind !== 'open_book') return REASON.kindOpenBook;
  return null;
}

/** One claim, checked for shape (not whether it is real, rare or near). @param {unknown} c @returns {ClaimCheck} */
export function checkClaim(c) {
  const o = c && typeof c === 'object' ? /** @type {Record<string, unknown>} */ (c) : {};
  const a = o.address, page = o.page, at = o.at, len = o.len;
  if (!isAddress(a) || !Number.isInteger(page) || /** @type {number} */ (page) < 1 || /** @type {number} */ (page) > PAGES || !Number.isInteger(at)
      || (len !== undefined && (!Number.isInteger(len) || /** @type {number} */ (len) > MAX_CLAIM_LEN))) return { ok: false, reason: REASON.badClaim };
  return { ok: true, claim: { address: address(a), page: /** @type {number} */ (page), at: /** @type {number} */ (at), len: /** @type {number | undefined} */ (len) } };
}

/** An error as the world sends it. @param {string} reason @param {string} [forType] */
export const error = (reason, forType) => (forType ? { t: 'error', for: forType, reason } : { t: 'error', reason });

// ------------------------------------------------------------------ world → client: shapes, and readers

/**
 * A person as others see them. vx, vy only for a human on the move (carry them forward by it between messages).
 * @typedef {{ id: string, kind: 'human' | 'agent', name: string, x: number, y: number, floor: number, side: 0 | 1, yaw: number,
 *   state: 'standing' | 'walking' | 'reading' | 'falling', vx?: number, vy?: number, crossed?: boolean }} Person
 * @typedef {Person & { present: boolean, updatedAt: number, farthestY: number, farthestFloor: number, farthestAt: number | null, booksOpened: number }} RosterEntry
 * @typedef {{ side: 0 | 1, floor: number, unit: number, shelf: number, slot: number, page: number, at: number, len: number, words: number,
 *   text: string, finder: string, agent: 0 | 1, foundAt: number }} BoardFind
 * @typedef {{ name: string, min: number, top: BoardFind[] }} BoardSide   min: the length a find on this side needs to place
 * @typedef {{ top: BoardFind[], min: number, sides: [BoardSide, BoardSide] }} Board   top: both sides together
 * @typedef {{ id: number, night: number, side: 0 | 1, floor: number, unit: number, shelf: number, slot: number, kind: 'open_book', text: string, author: string, createdAt: number }} MarkRow
 * @typedef {{ ok: true, first: boolean, rank: number, overall: number, side: string, text: string, finder: string, address: Required<Address>, page: number, at: number }
 *   | { ok: false, reason: string }} FoundResult
 */
/**
 * @typedef {{ t: 'welcome', you: Person, night: number, nextAt: number, rules: { walk: number, run: number }, board: Board }} Welcome
 * @typedef {{ t: 'correct', x: number, y: number, floor: number, side: 0 | 1, reason: 'too fast' | 'night', crossed?: boolean }} Correct   put back where the world has you
 * @typedef {{ t: 'peers', at: number, peers: Person[] }} Peers   the nearest 32, when someone in view changes
 * @typedef {{ t: 'roster', players: RosterEntry[] }} Roster   answer to map
 * @typedef {{ t: 'board', board: Board }} BoardMsg   to everyone, after a find places
 * @typedef {{ t: 'found', results: FoundResult[], board: Board }} Found   answer to finds, one result per claim read
 * @typedef {{ t: 'marks', replace: true, marks: MarkRow[] }} Marks   tonight's marks around you, when you come near new ones
 * @typedef {{ t: 'mark', mark: MarkRow }} MarkMsg   someone nearby left one
 * @typedef {{ t: 'marked', mark: MarkRow }} Marked   answer to mark
 * @typedef {{ t: 'night', n: number, nextAt: number }} Night   every mark is gone
 * @typedef {{ t: 'replaced' }} Replaced   another tab took over this identity; the socket closes (4000)
 * @typedef {{ t: 'rekey', anon: string }} Rekey   keep this secret instead: the old one stops working
 * @typedef {{ t: 'full', retryInS: number }} Full   a crowded night: the socket closes (4002); try again later
 * @typedef {{ t: 'error', for?: string, reason: string }} ErrorMsg
 * @typedef {{ t: 'pong', at: number, at0?: number }} Pong
 * @typedef {Welcome | Correct | Peers | Roster | BoardMsg | Found | Marks | MarkMsg | Marked | Night | Replaced | Rekey | Full | ErrorMsg | Pong} ServerMsg
 */

/** What a find on this side must reach to place on its board. @param {Board} board @param {number} [side] */
export const boardMin = (board, side) => board.sides[side === 1 ? 1 : 0].min;
/** Every find on the board, both sides. @param {Board | null | undefined} board @returns {BoardFind[]} */
export const boardFinds = board => (board ? board.sides.flatMap(s => s.top) : []);

// ------------------------------------------------------------------ world → client: builders
// What the world sends, made in one place: src/world.ts builds every message with these (W.welcome, W.peers, …), and
// read() below reads each back the way a client sees it. A builder takes the message's fields and returns the message
// with exactly those fields, in a fixed order, optional ones left out when absent: read() returns the same shape, so a
// message round-trips builder → encode → read unchanged. They take the world's own (looser) shapes — a side as any
// number, a mark's kind as a string, a board as the store keeps it — and send them in the shapes documented above.
/**
 * @typedef {Omit<Person, 'side'> & { side?: number }} PersonIn
 * @typedef {Omit<RosterEntry, 'side'> & { side?: number }} RosterEntryIn
 * @typedef {Omit<BoardFind, 'side' | 'agent'> & { side: number, agent: number }} BoardFindIn
 * @typedef {{ top: BoardFindIn[], min: number, sides: Array<{ name: string, min: number, top: BoardFindIn[] }> }} BoardIn
 * @typedef {Omit<MarkRow, 'side' | 'kind'> & { side: number, kind: string }} MarkRowIn
 * @typedef {{ ok: false, reason: string } | (Omit<Extract<FoundResult, { ok: true }>, 'address'> & { address: Address })} FoundResultIn
 */

/** A person as others see them (World.pub): vx/vy only when given. @param {PersonIn} p @returns {Person} */
export function person(p) {
  /** @type {Person} */
  const o = { id: p.id, kind: p.kind, name: p.name, x: p.x, y: p.y, floor: p.floor, side: sideOf(p), yaw: p.yaw, state: p.state };
  if (p.vx !== undefined) o.vx = p.vx;
  if (p.vy !== undefined) o.vy = p.vy;
  if (p.crossed) o.crossed = true;   // only for you, mid-fall: already crossed the shaft this fall (once a fall)
  return o;
}
/** A person in the roster (the map's list). @param {RosterEntryIn} p @returns {RosterEntry} */
export const rosterEntry = p => ({ ...person(p), present: !!p.present, updatedAt: p.updatedAt, farthestY: p.farthestY, farthestFloor: p.farthestFloor,
  farthestAt: p.farthestAt ?? null, booksOpened: p.booksOpened });
/** One of tonight's marks. @param {MarkRowIn} k @returns {MarkRow} */
export const markRow = k => ({ id: k.id, night: k.night, side: sideOf(k), floor: k.floor, unit: k.unit, shelf: k.shelf, slot: k.slot,
  kind: /** @type {'open_book'} */ ('open_book'), text: k.text ?? '', author: k.author, createdAt: k.createdAt });

/**
 * The board as the store keeps it, sent as is (it is built once per change and carried by every welcome and claim
 * reply, so it is not copied): the store's rows already are BoardFinds, two sides of them.
 * @param {BoardIn} b @returns {Board}
 */
const boardOf = b => /** @type {Board} */ (/** @type {unknown} */ (b));

/** World → client builders. Names match S (and the message's t). */
export const W = Object.freeze({
  /** @param {{ you: PersonIn, night: number, nextAt: number, rules: { walk: number, run: number }, board: BoardIn }} o @returns {Welcome} */
  welcome: o => ({ t: 'welcome', you: person(o.you), night: o.night, nextAt: o.nextAt, rules: { walk: o.rules.walk, run: o.rules.run }, board: boardOf(o.board) }),
  /** Put back where the world has you. @param {{ x: number, y: number, floor: number, side: number, reason: string }} o @returns {Correct} */
  correct: o => ({ t: 'correct', x: o.x, y: o.y, floor: o.floor, side: sideOf(o), reason: /** @type {Correct['reason']} */ (o.reason), ...(o.crossed ? { crossed: true } : {}) }),
  /** @param {number} at @param {PersonIn[]} peers @returns {Peers} */
  peers: (at, peers) => ({ t: 'peers', at, peers: peers.map(person) }),
  /**
   * The fast path for the fan-out: the frame's text, from people already turned into JSON once per tick (each the
   * JSON of a person()), as an array or already joined with commas. Reads back as W.peers(at, those people).
   * @param {number} at @param {string[] | string} peersJson @returns {string}
   */
  peersFrame: (at, peersJson) => `{"t":"peers","at":${+at},"peers":[${Array.isArray(peersJson) ? peersJson.join(',') : peersJson}]}`,
  /** @param {RosterEntryIn[]} players @returns {Roster} */
  roster: players => ({ t: 'roster', players: players.map(rosterEntry) }),
  /** @param {BoardIn} board @returns {BoardMsg} */
  board: board => ({ t: 'board', board: boardOf(board) }),
  /** One result per claim read, in order. @param {FoundResultIn[]} results @param {BoardIn} board @returns {Found} */
  found: (results, board) => ({ t: 'found', results: results.map(r => (r.ok ? { ...r, address: address(r.address) } : { ok: false, reason: r.reason })), board: boardOf(board) }),
  /** Tonight's marks around you (replacing what you had). @param {MarkRowIn[]} marks @returns {Marks} */
  marks: marks => ({ t: 'marks', replace: true, marks: marks.map(markRow) }),
  /** Someone nearby left a mark. @param {MarkRowIn} k @returns {MarkMsg} */
  mark: k => ({ t: 'mark', mark: markRow(k) }),
  /** Your mark, left. @param {MarkRowIn} k @returns {Marked} */
  marked: k => ({ t: 'marked', mark: markRow(k) }),
  /** @param {number} n @param {number} nextAt @returns {Night} */
  night: (n, nextAt) => ({ t: 'night', n, nextAt }),
  /** @returns {Replaced} */
  replaced: () => ({ t: 'replaced' }),
  /** @param {string} anon @returns {Rekey} */
  rekey: anon => ({ t: 'rekey', anon }),
  /** @param {number} retryInS @returns {Full} */
  full: retryInS => ({ t: 'full', retryInS }),
  /** @param {string} reason @param {string} [forType] @returns {ErrorMsg} */
  error: (reason, forType) => /** @type {ErrorMsg} */ (error(reason, forType)),
  /** @param {number} at @param {unknown} [at0] echoed only when a number @returns {Pong} */
  pong: (at, at0) => (typeof at0 === 'number' ? { t: 'pong', at, at0 } : { t: 'pong', at }),
});

// ------------------------------------------------------------------ world → client: reading a frame

/**
 * @typedef {{ ok: true, msg: ServerMsg }} Read
 * @typedef {{ ok: false, reason: string }} Unread   why the frame was dropped, for the log
 */
class Bad extends Error {}
/** @param {string} why @returns {never} */
const bad = why => { throw new Bad(why); };
const isObj = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v @param {string} what @returns {Record<string, any>} */
const obj = (v, what) => (isObj(v) ? /** @type {Record<string, any>} */ (v) : bad(`${what}: not an object`));
/** @param {unknown} v @param {string} what @returns {number} */
const num = (v, what) => (typeof v === 'number' && isFinite(v) ? v : bad(`${what}: not a number`));
/** @param {unknown} v @param {string} what @returns {string} */
const str = (v, what) => (typeof v === 'string' ? v : bad(`${what}: not a string`));
/** @param {unknown} v @param {string} what @returns {unknown[]} */
const arr = (v, what) => (Array.isArray(v) ? v : bad(`${what}: not a list`));
/** @param {unknown} v @param {number} d */
const numOr = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
/** @param {unknown} v @param {string} d */
const strOr = (v, d) => (typeof v === 'string' ? v : d);
const KINDS = ['human', 'agent'], STATES = ['standing', 'walking', 'reading', 'falling'];

/** @param {unknown} v @param {string} what @returns {Person} */
function readPerson(v, what) {
  const p = obj(v, what);
  return person({ id: str(p.id, what + '.id'), kind: KINDS.includes(p.kind) ? p.kind : 'human', name: strOr(p.name, ''),
    x: num(p.x, what + '.x'), y: num(p.y, what + '.y'), floor: num(p.floor, what + '.floor'), side: p.side === 1 ? 1 : 0, yaw: numOr(p.yaw, 0),
    state: STATES.includes(p.state) ? p.state : 'standing',
    ...(typeof p.vx === 'number' && isFinite(p.vx) ? { vx: p.vx } : {}), ...(typeof p.vy === 'number' && isFinite(p.vy) ? { vy: p.vy } : {}), ...(p.crossed === true ? { crossed: true } : {}) });
}
/** @param {unknown} v @param {string} what @returns {BoardFind} */
function readFind(v, what) {
  const f = obj(v, what);
  return { side: f.side === 1 ? 1 : 0, floor: num(f.floor, what + '.floor'), unit: num(f.unit, what + '.unit'), shelf: numOr(f.shelf, 0), slot: numOr(f.slot, 0),
    page: num(f.page, what + '.page'), at: num(f.at, what + '.at'), len: num(f.len, what + '.len'), words: numOr(f.words, 0), text: strOr(f.text, ''),
    finder: strOr(f.finder, ''), agent: f.agent ? 1 : 0, foundAt: numOr(f.foundAt, 0) };
}
/** @param {unknown} v @param {string} what @returns {Board} */
function readBoard(v, what) {
  const b = obj(v, what), sides = arr(b.sides, what + '.sides');
  if (sides.length !== 2) bad(`${what}.sides: not two sides`);
  const side = (/** @type {unknown} */ s, /** @type {number} */ i) => {
    const o = obj(s, `${what}.sides[${i}]`);
    return { name: strOr(o.name, i ? 'west' : 'east'), min: num(o.min, `${what}.sides[${i}].min`), top: arr(o.top ?? [], `${what}.sides[${i}].top`).map((f, j) => readFind(f, `${what}.sides[${i}].top[${j}]`)) };
  };
  const two = /** @type {[BoardSide, BoardSide]} */ ([side(sides[0], 0), side(sides[1], 1)]);
  return { top: arr(b.top ?? [], what + '.top').map((f, j) => readFind(f, `${what}.top[${j}]`)), min: numOr(b.min, Math.min(two[0].min, two[1].min)), sides: two };
}
/** @param {unknown} v @param {string} what @returns {MarkRow} */
function readMark(v, what) {
  const k = obj(v, what);
  if (k.kind !== undefined && k.kind !== 'open_book') bad(`${what}.kind: ${String(k.kind)}`);
  return markRow({ id: num(k.id, what + '.id'), night: numOr(k.night, 0), side: k.side === 1 ? 1 : 0, floor: num(k.floor, what + '.floor'), unit: num(k.unit, what + '.unit'),
    shelf: num(k.shelf, what + '.shelf'), slot: num(k.slot, what + '.slot'), kind: 'open_book', text: strOr(k.text, ''), author: strOr(k.author, ''), createdAt: numOr(k.createdAt, 0) });
}
/** @param {unknown} v @param {string} what @returns {FoundResult} */
function readResult(v, what) {
  const r = obj(v, what);
  if (r.ok !== true) return { ok: false, reason: strOr(r.reason, 'refused') };
  const a = obj(r.address, what + '.address');
  if (!isAddress(a)) bad(`${what}.address: not an address`);
  return { ok: true, first: !!r.first, rank: num(r.rank, what + '.rank'), overall: numOr(r.overall, 0), side: strOr(r.side, ''), text: strOr(r.text, ''),
    finder: strOr(r.finder, ''), address: address(/** @type {Address} */ (a)), page: num(r.page, what + '.page'), at: num(r.at, what + '.at') };
}

/** @param {Record<string, any>} m @returns {ServerMsg} */
function readMsg(m) {
  switch (m.t) {
    case 'welcome': {
      const r = isObj(m.rules) ? m.rules : {};
      return W.welcome({ you: readPerson(m.you, 'you'), night: num(m.night, 'night'), nextAt: num(m.nextAt, 'nextAt'),
        rules: { walk: numOr(r.walk, WALK), run: numOr(r.run, RUN) }, board: readBoard(m.board, 'board') });
    }
    case 'correct':
      return W.correct({ x: num(m.x, 'x'), y: num(m.y, 'y'), floor: num(m.floor, 'floor'), side: m.side === 1 ? 1 : 0, reason: strOr(m.reason, 'too fast'), crossed: m.crossed === true });
    case 'peers':   // a person who can't be read is left out, not the whole frame
      return { t: 'peers', at: numOr(m.at, 0), peers: arr(m.peers, 'peers').flatMap((p, i) => { try { return [readPerson(p, `peers[${i}]`)]; } catch { return []; } }) };
    case 'roster':
      return { t: 'roster', players: arr(m.players, 'players').flatMap((p, i) => {
        try {
          const o = /** @type {Record<string, any>} */ (p), you = readPerson(p, `players[${i}]`);
          return [rosterEntry({ ...you, present: !!o.present, updatedAt: numOr(o.updatedAt, 0), farthestY: numOr(o.farthestY, you.y),
            farthestFloor: numOr(o.farthestFloor, you.floor), farthestAt: typeof o.farthestAt === 'number' ? o.farthestAt : null, booksOpened: numOr(o.booksOpened, 0) })];
        } catch { return []; }
      }) };
    case 'board': return W.board(readBoard(m.board, 'board'));
    case 'found': return W.found(arr(m.results, 'results').map((r, i) => readResult(r, `results[${i}]`)), readBoard(m.board, 'board'));
    case 'marks': return { t: 'marks', replace: true, marks: arr(m.marks, 'marks').map((k, i) => readMark(k, `marks[${i}]`)) };
    case 'mark': return W.mark(readMark(m.mark, 'mark'));
    case 'marked': return W.marked(readMark(m.mark, 'mark'));
    case 'night': return W.night(num(m.n, 'n'), num(m.nextAt, 'nextAt'));
    case 'replaced': return W.replaced();
    case 'rekey': return ANON.test(str(m.anon, 'anon')) ? W.rekey(m.anon) : bad('anon: not a secret');
    case 'full': return W.full(numOr(m.retryInS, 120));
    case 'error': return W.error(str(m.reason, 'reason'), typeof m.for === 'string' ? m.for : undefined);
    case 'pong': return W.pong(num(m.at, 'at'), m.at0);
    default: return bad('unknown message type');
  }
}

/**
 * A frame from the world, read: the message with every field it should have (defaults filled in where the world may
 * leave one out), unknown fields dropped; or why it can't be read (not JSON, not an object, an unknown type, a field
 * missing or of the wrong kind), for the client to log and drop. Takes the frame's text or already-parsed JSON.
 * @param {unknown} raw @returns {Read | Unread}
 */
export function read(raw) {
  let m = raw;
  if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch { return { ok: false, reason: 'not JSON' }; } }
  if (!isObj(m)) return { ok: false, reason: 'not an object' };
  const o = /** @type {Record<string, any>} */ (m);
  if (!Object.hasOwn(S, o.t)) return { ok: false, reason: `unknown message type ${String(o.t)}` };
  try { return { ok: true, msg: readMsg(o) }; } catch (e) {
    if (e instanceof Bad) return { ok: false, reason: `${String(o.t)}: ${e.message}` };
    throw e;
  }
}
