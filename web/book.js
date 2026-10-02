// The open book: which book it is, the page it is open at, the finds on it, where its text comes from and whether the
// world hears about it. One module for the three ways a book is opened (from the shelf in front of you, from a search
// or a call slip far away, from a shelf after a teleport); the page only renders what it says, and scripts/check-book.ts
// checks it with no page. Plain JavaScript like walk.js: no DOM, no clock, no globals.
//
// Two text sources, behind one interface:
//   home(address, { finds, send })  a book on your own shelves. Its text is babel.js pageText, and it tells the world
//                                   (send, given protocol.js frames) when it is opened, turned and closed: others see
//                                   you reading, and the server keeps the page.
//   far(address, { page, line, col, text, finds })
//                                   a book read from its address alone (bookReader): from a search, a call slip, or a
//                                   shelf after a teleport. Silent: the server speaks home addresses only. Given the
//                                   text a search placed at page/line/col, the book checks it really is there and, if so,
//                                   holds it as a find (`there`: true, false, or null when no text was given).
//
// A book: { floor, unit, side, shelf, slot, far, page, finds, there }, and
//   open()        tells the world it was opened (home); returns the book
//   close()       tells the world it was closed (home)
//   goTo(n)       opens at page n, clamped to 1..410, and tells the world (home); returns the page
//   turn(d)       goTo(page + d)
//   nextFind()    goes to the first find on a later page, else back to the first; returns it, or null when none
//   addFinds(fs)  adds the finds not already held (same page and place), in page order; returns how many were new
//   here()        the finds on this page, in reading order
//   text(n)       page n's text (default: this page), 40 lines of 80 with a newline after each line but the last
//   address()     the address alone, for protocol.js
// Finds: { page, at, len, text, ... }, `at` counting characters on the page in reading order, newlines not counted.
import { pageText, bookReader, PAGES, COLS } from './babel.js';
import * as Proto from './protocol.js';

/**
 * @typedef {{ floor: any, unit: any, side?: number, shelf: number, slot: number }} Address   floor, unit: numbers or babel.js bigs
 * @typedef {{ page: number, at: number, len: number, text: string, [k: string]: unknown }} Find
 * @typedef {(frame: object) => void} Send
 * @typedef {{ floor: any, unit: any, side: 0 | 1, shelf: number, slot: number, far: boolean, page: number, finds: Find[], there: boolean | null,
 *   address(): object, text(n?: number): string, here(): Find[], open(): Book, close(): void, goTo(n: number): number, turn(d: number): number,
 *   nextFind(): Find | null, addFinds(fs: Find[]): number }} Book
 */

export { PAGES };
/** @param {unknown} n @returns {number} */
export const clampPage = n => Math.max(1, Math.min(PAGES, Math.round(Number(n)) || 1));
/** @param {Find} a @param {Find} b */
const byPage = (a, b) => a.page - b.page;
/** @type {Send} */
const silent = () => {};

/** @param {Address} address @param {boolean} far @param {(n: number) => string} read @param {Send} tell @param {number} page @param {Find[]} finds @returns {Book} */
function make(address, far, read, tell, page, finds) {
  /** @type {Book} */
  const book = {
    floor: address.floor, unit: address.unit, side: address.side === 1 ? 1 : 0, shelf: address.shelf, slot: address.slot,
    far, page: clampPage(page), finds: [...finds].sort(byPage), there: /** @type {boolean | null} */ (null),
    address: () => Proto.address(book),
    text: (n = book.page) => read(clampPage(n)),
    here: () => book.finds.filter(f => f.page === book.page).sort((a, b) => a.at - b.at),
    open() { tell(Proto.open(book)); return book; },
    close() { tell(Proto.close()); },
    goTo(n) { book.page = clampPage(n); tell(Proto.page(book.page)); return book.page; },
    turn: d => book.goTo(book.page + d),
    nextFind() {
      if (!book.finds.length) return null;
      const f = book.finds.find(x => x.page > book.page) || book.finds[0];
      book.goTo(f.page); return f;
    },
    addFinds(fs) {
      const fresh = (fs || []).filter(f => !book.finds.some(g => g.page === f.page && g.at === f.at));
      if (fresh.length) book.finds = book.finds.concat(fresh).sort(byPage);
      return fresh.length;
    },
  };
  return book;
}

/**
 * A book on your own shelves: babel.js pageText, and the world hears of it through send(frame).
 * @param {Address} address @param {{ finds?: Find[], send?: Send }} [o] @returns {Book}
 */
export function home(address, { finds = [], send = silent } = {}) {
  return make(address, false, n => pageText(address, n), send, 1, finds);
}

/**
 * A book read from its address alone, far away: bookReader, silent.
 * @param {Address} address @param {{ page?: number, line?: number, col?: number, text?: string, finds?: Find[] }} [o] @returns {Book}
 */
export function far(address, { page = 1, line = 1, col = 1, text = '', finds = [] } = {}) {
  const read = bookReader(address), p = clampPage(page), at = (line - 1) * COLS + col - 1;
  const there = !!text && read(p).replace(/\n/g, '').slice(at, at + text.length) === text;
  const book = make(address, true, read, silent, p, there ? [{ page: p, at, len: text.length, text }] : []);
  book.addFinds(finds); book.there = text ? there : null;
  return book;
}
