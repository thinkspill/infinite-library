// What the page is doing, and so what a key, a tap or a close does and whether the pointer should be locked. One pure
// module for the rules every dialog used to restate for itself: the page reads its mode (which overlays are showing),
// asks here, and applies the answer (opens and closes, locks and frees the pointer). scripts/check-modes.ts checks it
// with no page. Plain JavaScript like walk.js: no DOM, no clock, no globals.
//
// A mode: { entry, reading, touch, open: { help, how, search, map } }
//   entry: the entry card is up; reading: a book is open; touch: a phone (no pointer lock, no keys);
//   open: which dialogs are showing. Dialogs stack in DIALOGS order, top first, over the reader, over the world.
// A context (what a key means also depends on): { typing, online, away, far, autoWalk }
//   typing: the key went to a text field; online: shared with others (the map, leaving a book open);
//   away: teleported (H goes home; local only); far: the open book is far away (it cannot be left open); autoWalk: on
// Actions, as strings the page switches on:
//   'open:<dialog>', 'close:<dialog>'   help, how, search, map
//   'open:book', 'close:book', 'turn:1', 'turn:-1', 'nextFind', 'leaveMark'
//   'climb', 'autoWalk' (toggle), 'stopAuto', 'home', 'near' (toggle the words nearby), 'hold' (a walking key: held)
// Pointer: 'lock' (in the world on a desktop, nothing open), 'free' (a dialog is up, or a phone), 'keep' (as it is: the
//   entry card, or reading, where the mouse looks at nothing but the page may be clicked).

/**
 * @typedef {'help' | 'how' | 'search' | 'map'} Dialog
 * @typedef {{ entry: boolean, reading: boolean, touch: boolean, open: Record<Dialog, boolean> }} Mode
 * @typedef {{ typing?: boolean, online?: boolean, away?: boolean, far?: boolean, autoWalk?: boolean }} Context
 * @typedef {{ acts: string[], prevent: boolean }} KeyResult
 */

/** @type {readonly Dialog[]} */
export const DIALOGS = Object.freeze(['help', 'how', 'search', 'map']);   // top first
export const WALK_KEYS = Object.freeze(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);   // held, and the page must not scroll

const NONE = Object.freeze({ help: false, how: false, search: false, map: false });
/** @param {{ entry?: boolean, reading?: boolean, touch?: boolean, open?: Partial<Record<Dialog, boolean | undefined>> }} [m] @returns {Mode} */
export const mode = (m = {}) => ({ entry: !!m.entry, reading: !!m.reading, touch: !!m.touch, open: { ...NONE, ...(m.open || {}) } });

/** The topmost dialog showing, or null. @param {Mode} m @returns {Dialog | null} */
export const topDialog = m => DIALOGS.find(d => m.open[d]) || null;

/** What is on top: 'entry', a dialog, 'reading' or 'walking'. (A dialog opened from the entry card is over it.) @param {Mode} m @returns {string} */
export const top = m => topDialog(m) || (m.entry ? 'entry' : m.reading ? 'reading' : 'walking');

/** Whether the pointer should be locked, freed, or left as it is. @param {Mode} m @returns {'lock' | 'free' | 'keep'} */
export function pointer(m) {
  if (m.touch || topDialog(m)) return 'free';
  if (m.entry || m.reading) return 'keep';
  return 'lock';
}

/** @param {string[]} acts @returns {KeyResult} */
const r = (acts, prevent = false) => ({ acts, prevent });
const IGNORE = r([]);

/**
 * A key: { code, key } (KeyboardEvent's). Returns { acts: action[], prevent } — prevent: the page calls preventDefault.
 * Order matters and is the old handler's: help is over how is over the search; ? and the map's M reach past the reader.
 * @param {Mode} m @param {{ code: string, key: string }} ev @param {Context} [ctx] @returns {KeyResult}
 */
export function key(m, { code, key: k }, ctx = {}) {
  const esc = code === 'Escape';
  if (m.entry || ctx.typing) return esc && m.open.how && !m.open.help ? r(['close:how']) : IGNORE;
  if (m.open.help) return esc || k === '?' ? r(['close:help']) : IGNORE;
  if (k === '?') return r(['open:help'], true);   // Shift+/: before / opens the search
  if (m.open.how) return esc || code === 'KeyI' ? r(['close:how']) : IGNORE;
  if (m.open.search) return esc ? r(['close:search']) : IGNORE;
  if (code === 'KeyI' && !m.reading) return r(['open:how'], true);
  if (code === 'Slash' && !m.reading) return r(['open:search'], true);
  if (code === 'KeyM' && ctx.online) return r([m.open.map ? 'close:map' : 'open:map'], true);
  if (m.open.map) return esc ? r(['close:map']) : IGNORE;
  if (code === 'KeyE') return r([m.reading ? 'close:book' : 'open:book'], true);
  if (code === 'KeyF') return r(['climb'], true);
  if (code === 'KeyQ' && !m.reading) return r(['autoWalk'], true);
  const acts = ctx.autoWalk && (code === 'KeyS' || code === 'ArrowDown') ? ['stopAuto'] : [];   // stepping back stops it, however short the tap
  if (code === 'KeyH' && ctx.away && !m.reading) return r([...acts, 'home'], true);
  if (code === 'KeyL') return r([...acts, 'near'], true);
  if (m.reading) {
    if (code === 'KeyG') return r([...acts, 'nextFind'], true);
    if (code === 'KeyO' && ctx.online && !ctx.far) return r([...acts, 'leaveMark'], true);   // an open book is the only mark
    if (code === 'ArrowRight' || code === 'KeyD') acts.push('turn:1');
    if (code === 'ArrowLeft' || code === 'KeyA') acts.push('turn:-1');
    if (esc) acts.push('close:book');
    return r(acts, true);
  }
  return r([...acts, 'hold'], WALK_KEYS.includes(code));
}

/**
 * A tap on a phone's HUD button ('find', 'map', 'help'), or a dialog's close button or backdrop ('close:<dialog>').
 * Returns the action, or null when there is nothing to do.
 * @param {Mode} m @param {string} what @param {Context} [ctx] @returns {string | null}
 */
export function tap(m, what, ctx = {}) {
  if (what === 'find') return 'open:search';
  if (what === 'help') return 'open:help';
  if (what === 'map') return !m.open.map && ctx.online ? 'open:map' : null;
  const [verb, d] = what.split(':');
  return verb === 'close' && DIALOGS.includes(/** @type {Dialog} */ (d)) && m.open[/** @type {Dialog} */ (d)] ? what : null;
}
