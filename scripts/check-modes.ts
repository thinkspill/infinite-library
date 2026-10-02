// Checks web/modes.js, what the page is doing and so what a key, a tap or a close does and whether the pointer is
// locked: the dialogs' stacking order, Esc closing the top one only, keys ignored while typing or on the entry card,
// the pointer after every way of closing something (closing a book with a dialog open among them), a phone never
// locking, the map only online. No page: node scripts/check-modes.ts
import * as M from '../web/modes.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
type Open = { help?: boolean, how?: boolean, search?: boolean, map?: boolean };
const mode = (o: { entry?: boolean, reading?: boolean, touch?: boolean } & Open = {}) =>
  M.mode({ entry: o.entry, reading: o.reading, touch: o.touch, open: { help: o.help, how: o.how, search: o.search, map: o.map } });
const key = (m: ReturnType<typeof mode>, code: string, k = code, ctx = {}) => M.key(m, { code, key: k }, { online: true, ...ctx });
const acts = (m: ReturnType<typeof mode>, code: string, k = code, ctx = {}) => key(m, code, k, ctx).acts.join(' ');
// apply an action to a mode as the page does (dialogs and the book); returns the mode after
function after(m: ReturnType<typeof mode>, a: string) {
  const n = M.mode({ ...m, open: { ...m.open } }), [verb, what] = a.split(':');
  if (what === 'book') n.reading = verb === 'open';
  else if (verb === 'open' || verb === 'close') (n.open as Record<string, boolean>)[what] = verb === 'open';
  return n;
}

console.log('The stack');
{
  check(M.top(mode({ entry: true })) === 'entry' && M.top(mode()) === 'walking' && M.top(mode({ reading: true })) === 'reading', 'nothing open: entry, walking or reading');
  const all = mode({ reading: true, help: true, how: true, search: true, map: true });
  check(M.top(all) === 'help', 'help is over everything');
  check(M.top(mode({ reading: true, how: true, search: true, map: true })) === 'how', 'how is over the search, the map and the reader');
  check(M.top(mode({ reading: true, search: true, map: true })) === 'search', 'the search is over the map and the reader');
  check(M.top(mode({ reading: true, map: true })) === 'map', 'the map is over the reader');
  check(M.top(mode({ entry: true, how: true })) === 'how', 'how it works, opened from the entry card, is over it');
  // Esc, again and again, closes them one at a time from the top
  let m = all; const order: string[] = [];
  for (let i = 0; i < 6; i++) { const r = key(m, 'Escape'); if (!r.acts[0]?.startsWith('close:')) break; order.push(r.acts.join(' ')); m = after(m, r.acts[0]); }
  check(order.join(' > ') === 'close:help > close:how > close:search > close:map > close:book', `Esc closes the top one, each time: ${order.join(' > ')}`);
  check(M.top(m) === 'walking' && acts(m, 'Escape') === 'hold', 'and then Esc closes nothing (walking, it is just a key, as before)');
}

console.log('\nEach dialog takes its own keys and swallows the rest');
{
  check(acts(mode({ help: true }), 'Slash', '?') === 'close:help' && acts(mode({ help: true }), 'KeyE') === '' && acts(mode({ help: true }), 'KeyM') === '', 'help: ? or Esc closes it; E, M do nothing');
  check(acts(mode({ how: true }), 'KeyI') === 'close:how' && acts(mode({ how: true }), 'Slash') === '' && acts(mode({ how: true }), 'KeyW') === '', 'how: I or Esc closes it; / and W do nothing');
  check(acts(mode({ how: true }), 'Slash', '?') === 'open:help', '? opens help over how');
  check(acts(mode({ search: true }), 'Escape') === 'close:search' && acts(mode({ search: true }), 'KeyE') === '' && acts(mode({ search: true }), 'KeyM') === '', 'search: Esc closes it; E, M do nothing');
  check(acts(mode({ map: true }), 'KeyM') === 'close:map' && acts(mode({ map: true }), 'Escape') === 'close:map' && acts(mode({ map: true }), 'KeyE') === '', 'map: M or Esc closes it; E does nothing');
  check(acts(mode({ map: true }), 'Slash') === 'open:search' && acts(mode({ map: true }), 'KeyI') === 'open:how', 'the search and how open over the map');
}

console.log('\nWalking');
{
  const w = mode();
  const table: [string, string, string][] = [['KeyE', 'KeyE', 'open:book'], ['KeyF', 'KeyF', 'climb'], ['KeyQ', 'KeyQ', 'autoWalk'], ['KeyL', 'KeyL', 'near'],
    ['Slash', '/', 'open:search'], ['Slash', '?', 'open:help'], ['KeyI', 'KeyI', 'open:how'], ['KeyM', 'm', 'open:map'],
    ['KeyW', 'w', 'hold'], ['ArrowUp', 'ArrowUp', 'hold'], ['ShiftLeft', 'Shift', 'hold'], ['Space', ' ', 'hold']];
  for (const [code, k, want] of table) check(acts(w, code, k) === want, `${k}: ${want}`);
  check(key(w, 'Space', ' ').prevent && key(w, 'ArrowUp').prevent && !key(w, 'KeyW', 'w').prevent && !key(w, 'ShiftLeft').prevent, 'Space and arrows are held without scrolling; letters let through');
  check(acts(w, 'KeyS', 's', { autoWalk: true }) === 'stopAuto hold' && acts(w, 'ArrowDown', 'ArrowDown', { autoWalk: true }) === 'stopAuto hold' && acts(w, 'KeyS') === 'hold', 'S or ↓ while auto-walking stops it, and still steps back');
  check(acts(w, 'KeyH', 'h', { away: true }) === 'home' && acts(w, 'KeyH') === 'hold', 'H goes home only when away (teleport is local only)');
  check(acts(w, 'KeyG') === 'hold' && acts(w, 'KeyO') === 'hold', 'G and O mean nothing without a book');
}

console.log('\nReading');
{
  const r = mode({ reading: true });
  check(acts(r, 'ArrowRight') === 'turn:1' && acts(r, 'KeyD') === 'turn:1' && acts(r, 'ArrowLeft') === 'turn:-1' && acts(r, 'KeyA') === 'turn:-1', '→ / D and ← / A turn pages');
  check(acts(r, 'KeyE') === 'close:book' && acts(r, 'Escape') === 'close:book', 'E or Esc closes the book');
  check(acts(r, 'KeyG') === 'nextFind', 'G: the next find');
  check(acts(r, 'KeyO') === 'leaveMark' && acts(r, 'KeyO', 'o', { online: false }) === '' && acts(r, 'KeyO', 'o', { far: true }) === '', 'O leaves it open, online and only a book on these shelves');
  check(acts(r, 'KeyW') === '' && key(r, 'KeyW').prevent && acts(r, 'KeyQ') === '', 'no walking (W) or auto-walk (Q) with a book in hand');
  check(acts(r, 'Slash') === '' && acts(r, 'KeyI') === '' && acts(r, 'Slash', '?') === 'open:help' && acts(r, 'KeyM') === 'open:map', 'over the reader: help and the map open, the search and how do not');
  check(acts(r, 'KeyH', 'h', { away: true }) === '', 'H does not go home with a book open');
  check(acts(r, 'KeyF') === 'climb' && acts(r, 'KeyL') === 'near', 'F and L still go through (climb refuses with a book)');
  check(acts(mode({ reading: true, help: true }), 'Escape') === 'close:help' && acts(mode({ reading: true, map: true }), 'Escape') === 'close:map'
    && acts(mode({ reading: true, help: true }), 'ArrowRight') === '', 'Esc from a dialog over the reader closes the dialog only; arrows do not turn under it');
}

console.log('\nTyping and the entry card');
{
  const typing = { typing: true };
  for (const k of ['KeyE', 'KeyW', 'Slash', 'KeyM', 'KeyQ', 'Escape']) check(acts(mode(), k, k, typing) === '' && !key(mode(), k, k, typing).prevent, `typing: ${k} is the text's, not ours`);
  check(acts(mode({ how: true }), 'Escape', 'Escape', typing) === 'close:how', 'typing in how it works: Esc still closes it');
  check(acts(mode({ reading: true }), 'ArrowRight', 'ArrowRight', typing) === '', 'typing over the reader: arrows do not turn the page');
  for (const k of ['KeyE', 'KeyW', 'Slash', 'KeyM', 'KeyI']) check(acts(mode({ entry: true }), k) === '', `entry card: ${k} does nothing`);
  check(acts(mode({ entry: true, how: true }), 'Escape') === 'close:how', 'entry card: Esc closes how it works opened from it');
}

console.log('\nThe map is online only');
{
  check(acts(mode(), 'KeyM', 'm', { online: false }) === 'hold', 'offline, M is just a key');
  check(M.tap(mode({ touch: true }), 'map', { online: false }) === null && M.tap(mode({ touch: true }), 'map', { online: true }) === 'open:map', 'the map button opens it only online');
  check(M.tap(mode({ touch: true, map: true }), 'map', { online: true }) === null, 'and not again when it is open');
}

console.log('\nTaps, close buttons and backdrops');
{
  check(M.tap(mode(), 'find') === 'open:search' && M.tap(mode(), 'help') === 'open:help', 'find and help buttons open them');
  for (const d of M.DIALOGS) {
    check(M.tap(mode({ [d]: true }), 'close:' + d) === 'close:' + d, `${d}: its close button or backdrop closes it`);
    check(M.tap(mode(), 'close:' + d) === null, `${d}: closing it when it is not open does nothing (no second toggle)`);
  }
}

console.log('\nThe pointer');
{
  check(M.pointer(mode()) === 'lock', 'walking on a desktop: locked');
  check(M.pointer(mode({ entry: true })) === 'keep' && M.pointer(mode({ reading: true })) === 'keep', 'the entry card and the reader leave it as it is');
  for (const d of M.DIALOGS) check(M.pointer(mode({ [d]: true })) === 'free' && M.pointer(mode({ [d]: true, reading: true })) === 'free', `${d} open: freed`);
  // every way of closing something, as the page applies it, then asks
  const closes: [string, ReturnType<typeof mode>, string, string][] = [
    ['search, walking', mode({ search: true }), 'close:search', 'lock'],
    ['search, reading', mode({ search: true, reading: true }), 'close:search', 'keep'],
    ['search, how still open', mode({ search: true, how: true }), 'close:search', 'free'],
    ['help, walking', mode({ help: true }), 'close:help', 'lock'],
    ['help, the search under it', mode({ help: true, search: true }), 'close:help', 'free'],
    ['help, the map under it', mode({ help: true, map: true }), 'close:help', 'free'],
    ['how, walking', mode({ how: true }), 'close:how', 'lock'],
    ['how, the search under it', mode({ how: true, search: true }), 'close:how', 'free'],
    ['how, on the entry card', mode({ how: true, entry: true }), 'close:how', 'keep'],
    ['map, walking (it never re-locked)', mode({ map: true }), 'close:map', 'lock'],
    ['map, reading', mode({ map: true, reading: true }), 'close:map', 'keep'],
    ['book, nothing open', mode({ reading: true }), 'close:book', 'lock'],
    ['book, help open (it re-locked anyway)', mode({ reading: true, help: true }), 'close:book', 'free'],
    ['book, the map open', mode({ reading: true, map: true }), 'close:book', 'free'],
    ['book, the search open', mode({ reading: true, search: true }), 'close:book', 'free'],
  ];
  for (const [what, m, a, want] of closes) { const p = M.pointer(after(m, a)); check(p === want, `closing ${what}: ${want} (${p})`); }
  const phone = [mode({ touch: true }), mode({ touch: true, reading: true }), after(mode({ touch: true, reading: true }), 'close:book'), after(mode({ touch: true, search: true }), 'close:search'), after(mode({ touch: true, map: true }), 'close:map')];
  check(phone.every(m => M.pointer(m) !== 'lock'), 'a phone never locks, whatever closes');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
