// The proofs that search() finds books already on the shelves rather than making them up, as plain functions: each
// takes an address or a text, reads books only through babel.js (an address in, pages out), and returns what it did
// as data — the steps to show, the values behind them, whether it held, and where to highlight. The page's "How it
// works" dialog draws these (short-stay-library.html), scripts/prove-search.ts prints them, and
// scripts/check-proofs.ts checks them, wrong claims included.
//
// A result is { ok, verdict, steps, ...values } or, when the input can't be searched, { ok: false, error, steps: [] }.
// A step is { label } plus one of:
//   address           a shelf (render it however the reader names shelves), with ms when it was timed
//   text, quote?      a value in words; quote: show it in quotation marks
//   page              { text, from, to }: lines of a page, with text.slice(from, to) the part to highlight
import { pageText, bookReader, search, addressOfPages, repeatedBook, bookNumber, addressOf, describeWalk, bigEqual, PAGES, COLS } from './babel.js';

const now = () => (typeof performance !== 'undefined' ? performance : Date).now();
const flat = page => page.replace(/\n/g, '');

// Two addresses name the same book: side, floor, unit, shelf and slot (floor and unit may be numbers or Bigs).
export const sameShelf = (a, b) => (a.side || 0) === (b.side || 0) && a.shelf === b.shelf && a.slot === b.slot && bigEqual(a.floor, b.floor) && bigEqual(a.unit, b.unit);
const sameDigits = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

// A random book within a short walk of the spawn: floors -5..5, units -200..200, either side.
export const nearbyAddress = (rnd = Math.random) => ({ floor: Math.floor(rnd() * 11) - 5, unit: Math.floor(rnd() * 401) - 200, side: rnd() < 0.5 ? 0 : 1,
  shelf: Math.floor(rnd() * 6), slot: Math.floor(rnd() * 32) });

// Where `len` characters from reading position `at` sit in a page as rendered (lines of COLS joined by '\n'):
// [from, to) with text.slice(from, to) the run, line breaks inside it included.
export function markRange(at, len) {
  const pos = n => n + Math.floor(n / COLS);
  return [pos(at), pos(at + len - 1) + 1];
}

// The lines of a page around a run: from the run's first line to one past its last, at most `max` lines, with the
// run's [from, to) inside that excerpt (to clipped to it when the run goes on past the last line shown).
export function excerpt(page, at, len, max = 3) {
  const lines = page.split('\n'), first = Math.floor(at / COLS), last = Math.floor((at + len - 1) / COLS);
  const text = lines.slice(first, first + Math.min(max, last - first + 2)).join('\n'), off = first * (COLS + 1), [a, b] = markRange(at, len);
  return { text, from: a - off, to: Math.min(b - off, text.length) };
}

export function readBook(address) { const read = bookReader(address); return Array.from({ length: PAGES }, (_, i) => read(i + 1)); }

// A claim that `query` is written at page, line, col (1-based) of the book at `address`: read that page from the
// address alone and look. Returns { ok, found (what is really there), at, page (that page's text), mark }.
export function verifyClaim({ address, page, line, col, query }) {
  const text = bookReader(address)(page), at = (line - 1) * COLS + col - 1, found = flat(text).slice(at, at + query.length);
  return { ok: query.length > 0 && found === query, found, at, page: text, mark: markRange(at, query.length) };
}

// 1. A book you could walk to: its address is a book number and back again (the one-to-one map between shelves and
// numbers); its first line, searched for, leads to that very book, by the same number.
export function proveWalk(address) {
  const number = bookNumber(address), there = number && addressOf(number), roundTrip = !!there && sameShelf(there, address);
  const line = pageText(address, 1).split('\n')[0], t0 = now(), r = search(line), ms = now() - t0;
  const ok = roundTrip && sameShelf(address, r.address) && sameDigits(number, r.book);
  return { ok, address, number, roundTrip, line, found: r.address, foundNumber: r.book, ms,
    verdict: ok ? '✓ the very same book. Search found it; it did not make it up.' : '✗ a different book',
    steps: [{ label: 'A book', address }, { label: 'Its first line', text: line, quote: true }, { label: 'Searching for that line', address: r.address, ms }] };
}

// 2. Any text: search for it, then read the book at the address it gives, from the address alone, and look where
// the claim says. opts go to search() (page, at, blank).
export function proveAny(text, opts = {}) {
  let r; try { r = search(text, opts); } catch (e) { return { ok: false, error: e.message, steps: [] }; }
  const claim = { address: r.address, page: r.page, line: r.line, col: r.col, query: r.query }, check = verifyClaim(claim);
  const shown = excerpt(check.page, check.at, r.query.length);
  return { ok: check.ok, claim, check, shown,
    verdict: check.ok ? '✓ the text is there, where the address says.' : '✗ the text is not there',
    steps: [{ label: 'It is in the book at', address: r.address }, { label: 'On foot', text: `${describeWalk(r.address)} from the spawn` },
      { label: `Page ${r.page} of that book, rebuilt from the address alone`, page: shown }] };
}

// 3. A whole book, both ways: read all 410 pages from the address, run reading backwards over them, and land on the
// same shelf. `pages` skips the reading when the caller already has them.
export function proveBook(address, pages = readBook(address)) {
  const t0 = now(), back = addressOfPages(pages), ms = now() - t0, ok = sameShelf(address, back);
  return { ok, address, back, ms,
    verdict: ok ? '✓ the whole text leads back to its own shelf, and only there.' : '✗ it leads somewhere else',
    steps: [{ label: 'A book', address }, { label: `Its ${PAGES} pages, run backwards`, address: back, ms }] };
}

// 4. No slack: the same book with one letter of one page changed is shelved somewhere else.
export function proveEdit(address, page = 200, pages = readBook(address)) {
  const edited = pages.slice(); edited[page - 1] = (edited[page - 1][0] === 'a' ? 'b' : 'a') + edited[page - 1].slice(1);
  const moved = addressOfPages(edited), ok = !sameShelf(moved, address);
  return { ok, address, moved, page,
    verdict: ok ? '✓ one letter changed, and it is another book on another shelf.' : '✗ the changed text leads to the same shelf',
    steps: [{ label: 'A book', address }, { label: `Page ${page} with its first letter changed`, address: moved }] };
}

// 5. Your book: the one that is a name and nothing else (babel.js repeatedBook). Every one of its 410 pages, read
// from the address, is the name over and over, and those pages run backwards lead to the same shelf.
export function proveName(name) {
  const r = repeatedBook(name); if (!r) return { ok: false, error: 'nothing of that name is left to write', steps: [] };
  const pages = readBook(r.address), unit = r.text + ' ', K = flat(pages[0]).length;
  let good = 0; for (let p = 0; p < PAGES; p++) { const f = flat(pages[p]); let ok = f.length === K; for (let j = 0; ok && j < K; j++) ok = f[j] === unit[(p * K + j) % unit.length]; if (ok) good++; }
  const book = proveBook(r.address, pages), ok = good === PAGES && book.ok;
  return { ok, name: r.text, address: r.address, pagesGood: good, back: book.back, ms: book.ms,
    verdict: ok ? '✓ your name, and nothing else, all the way through, on its own shelf.' : '✗ that is not your book',
    steps: [{ label: 'Your name, as the library spells it', text: r.text, quote: true }, { label: 'Its book', address: r.address },
      { label: 'Pages that are nothing but it', text: `${good} of ${PAGES}` }, { label: `Its ${PAGES} pages, run backwards`, address: book.back, ms: book.ms }] };
}
