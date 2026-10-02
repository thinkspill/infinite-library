// Checks web/babel.js, the library's text, which the page and the server share:
// the address ⇄ book number ⇄ text bijection round-trips, search() finds what it claims, and nearby books
// don't share text (the old 32-bit generator read one 4.3-billion-character loop at different offsets).
import { readFileSync } from 'node:fs';
import * as B from '../web/babel.js';

const ok = (cond: unknown, what: string) => { if (!cond) { console.error('FAIL', what); process.exit(1); } console.log('ok  ', what); };
const rnd = (n: number) => Math.floor(Math.random() * n);
const sameBig = (a: any, b: any) => a.neg === b.neg && a.d.length === b.d.length && a.d.every((x: number, i: number) => x === b.d[i]);
const flatPage = (t: string) => t.replace(/\n/g, '');

const html = readFileSync(new URL('../web/short-stay-library.html', import.meta.url), 'utf8');
ok(/import \{[^}]*pageText[^}]*\} from '\.\/babel\.js'/.test(html) && !/function pageText\(/.test(html), 'the page reads books through babel.js, not a copy');
ok(!/stairUnits/.test(html) && /const unitsPerSide = SEG;/.test(html), 'every metre of wall has shelves (the stairs run along the railing), so every book is on one');

// address → book number → address
let bad = 0;
for (let i = 0; i < 2000; i++) {
  const a = { floor: rnd(2e6) - 1e6, unit: rnd(2e9) - 1e9, shelf: rnd(6), slot: rnd(32) };
  if (i < 4) Object.assign(a, [{ floor: 0, unit: 0 }, { floor: -1, unit: 0 }, { floor: Number.MAX_SAFE_INTEGER, unit: Number.MIN_SAFE_INTEGER }, { floor: 0, unit: -1 }][i]);
  const back = B.addressOf(B.bookNumber(a)!);
  if (B.bigToNumber(back.floor) !== a.floor || B.bigToNumber(back.unit) !== a.unit || back.shelf !== a.shelf || back.slot !== a.slot) bad++;
}
ok(bad === 0, 'address → book number → address, 2000 addresses');
{   // both galleries: the same floor, unit, shelf and slot on the two sides are different books, and each reads back
  let wrong = 0; const both = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const a = { floor: rnd(2e6) - 1e6, unit: rnd(2e9) - 1e9, side: i & 1, shelf: rnd(6), slot: rnd(32) };
    const n = B.bookNumber(a)!, back = B.addressOf(n);
    if (back.side !== a.side || B.bigToNumber(back.floor) !== a.floor || B.bigToNumber(back.unit) !== a.unit || back.shelf !== a.shelf || back.slot !== a.slot) wrong++;
  }
  for (const side of [0, 1]) for (let s = 0; s < 192; s++) both.add(B.pageText({ floor: 0, unit: 4, side, shelf: s >> 5, slot: s & 31 }, 1));
  ok(wrong === 0 && both.size === 384, 'both sides: 1,000 addresses read back to their own side, and the spawn unit\'s 384 books are all different');
}
const seen = new Set<string>();
for (let f = -3; f <= 3; f++) for (let u = -3; u <= 3; u++) for (let s = 0; s < 192; s++) seen.add(B.bookNumber({ floor: f, unit: u, shelf: s >> 5, slot: s & 31 })!.join(','));
ok(seen.size === 49 * 192, 'distinct addresses get distinct book numbers');

// search → address → text
let t0 = performance.now(), n = 0;
for (const [text, opts] of [
  ['some data.', {}], ['hello world', { page: 1, at: 0 }], ['the end', { page: 410, at: 3193 }],
  ['a short stay in hell', { blank: true }], ['you will find it here', { page: 410, blank: true }],
  [Array.from({ length: 3200 }, () => B.ALPHABET[rnd(29)]).join(''), {}],
] as [string, any][]) {
  const r = B.search(text, opts);
  const back = B.bookNumber(r.address)!;
  const page = flatPage(B.pageText(r.address, r.page));
  const at = (r.line - 1) * B.COLS + r.col - 1;
  ok(back.length === r.book.length && back.every((x, i) => x === r.book[i]) && page.slice(at, at + text.length) === text
    && (!opts.blank || page.replace(text, '').trim() === ''),
    `search ${JSON.stringify(text.slice(0, 24))}${text.length > 24 ? '…' : ''} → floor ${B.describeBig(r.address.floor).slice(0, 36)}…, page ${r.page} line ${r.line}: reads back`);
  n++;
}
console.log(`     ${((performance.now() - t0) / n).toFixed(0)} ms per search, including reading it back`);
ok(sameBig(B.search('abc').address.floor, B.search('abc').address.floor), 'search is deterministic');

// what people actually paste: text copied off a page, capitals, Windows line endings
{
  const reads = (r: any, want: string) => flatPage(B.bookReader(r.address)(r.page)).slice((r.line - 1) * B.COLS + r.col - 1).startsWith(want);
  const src = B.pageText({ floor: 0, unit: 5, shelf: 1, slot: 9 }, 12), lines = src.split('\n');
  const across = lines[0].slice(-10) + '\n' + lines[1].slice(0, 10), r1 = B.search(across);
  ok(r1.query === lines[0].slice(-10) + lines[1].slice(0, 10) && r1.length === 20 && reads(r1, r1.query),
    'text copied across a line break is searched as it stands on the page (the break is not a character)');
  const r2 = B.search(src, { page: 12 });
  ok(src.length === 3239 && r2.length === 3200 && B.bookReader(r2.address)(12) === src, 'a whole page copied from the reader (3,239 characters with its breaks) is one page');
  const r3 = B.search('Hello\r\nWorld\tAgain', { page: 3, at: 100 });
  ok(r3.query === 'helloworld again' && reads(r3, r3.query), 'capitals, CRLF and tabs: searched as lowercase, no break, a space');
}

// placement must be on a real page at a whole character
for (const [opts, what] of [[{ page: 2.5 }, 'page 2.5'], [{ page: '5' }, "page '5'"], [{ page: 0 }, 'page 0'], [{ page: 411 }, 'page 411'],
  [{ page: 3, at: 10.5 }, 'at 10.5'], [{ page: 3, at: -1 }, 'at -1'], [{ page: 3, at: 3199 }, 'at 3199 for 5 characters']] as [any, string][]) {
  let threw = false; try { B.search('hello', opts); } catch (e) { threw = e instanceof RangeError; }
  ok(threw, `search rejects ${what}`);
}

// search places exactly what was typed: no spaces added, so a phrase can be found joined to its neighbours,
// and typing the spaces yourself is what makes it stand as its own words for the phrase finder
{
  const flatAt = (r: any) => { const p = flatPage(r.text), at = (r.line - 1) * B.COLS + r.col - 1; return { p, at, end: at + r.length }; };
  const a = B.search('hello world', { page: 9, at: 500 }), { p, at, end } = flatAt(a);
  ok(p.slice(at, end) === 'hello world', 'a searched phrase is placed exactly as typed');
  let spaced = 0;
  for (const w of B.ALPHABET.slice(0, 26)) { const f = flatAt(B.search(`${w}ord`, { page: 4, at: 900 })); if (f.p[f.at - 1] === ' ' || f.p[f.end] === ' ') spaced++; }
  ok(spaced < 10, `no space is added beside the text (${spaced} of 26 had one beside it by chance, ~2 expected)`);
  const { scanPageOf, loadWords } = await import('../web/scan.js');
  const words = loadWords(readFileSync(new URL('../web/words.txt', import.meta.url), 'utf8'));
  const seen = (q: string) => { const r = B.search(q); return scanPageOf(r.address, r.page, words).some((f: any) => f.text === q.trim()); };
  ok([' the quick brown fox jumps over the lazy dog. ', ' once upon a time there was a library ', ' hello world '].every(seen), 'typed with spaces around it, a phrase is seen whole by the phrase finder');
}

// your book: the one that is nothing but your name, page after page, read back from its address alone
{
  const t0 = performance.now(), r = B.repeatedBook('Patient Scribe')!, ms = performance.now() - t0, read = B.bookReader(r.address);
  const want = (p: number) => Array.from({ length: B.LINES * B.COLS }, (_, j) => 'patient scribe '[((p - 1) * 3200 + j) % 15]).join('');
  ok(r.text === 'patient scribe' && [1, 2, 205, 410].every(p => flatPage(read(p)) === want(p)) && B.log10Big(r.address.floor) > 959000,
    `a name's own book: "patient scribe " on every page, read back from an address ~10^${Math.round(B.log10Big(r.address.floor)).toLocaleString('en-US')} away (${ms.toFixed(0)} ms)`);
  ok(B.repeatedBook('José O’Brien')!.text === 'jose obrien' && B.repeatedBook('42') === null, 'names lose their accents and apostrophes; one with no letters has no book');
}

// call slips write a far address out in decimal; reading one back must reach exactly the same book
{
  const text = 'are we really sure this text was already located here', r = B.search(text);
  const t0 = performance.now(), floor = B.bigToDecimal(r.address.floor), unit = B.bigToDecimal(r.address.unit);
  const back = { floor: B.bigFromDecimal(floor), unit: B.bigFromDecimal(unit), side: r.address.side, shelf: r.address.shelf, slot: r.address.slot };
  const page = B.bookReader(back)(r.page).replace(/\n/g, ''), at = (r.line - 1) * B.COLS + r.col - 1;
  ok(sameBig(back.floor, r.address.floor) && sameBig(back.unit, r.address.unit) && page.slice(at, at + text.length) === text,
    `a call slip's decimal address (${(floor.length + unit.length).toLocaleString()} digits) reads back the same book (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  ok(B.bigToDecimal(B.bigFromNumber(-123456789)) === '-123456789' && B.bigToNumber(B.bigFromDecimal('0')) === 0, 'small numbers convert both ways');
}

// nearby books: uniform symbols, and no shared stretches
t0 = performance.now();
const counts = new Array(29).fill(0), grams = new Set<number>();
let pages = 0, dup = 0;
for (let u = -2; u <= 2; u++) for (let s = 0; s < 192; s += 1) {
  const a = { floor: 0, unit: u, shelf: s >> 5, slot: s & 31 };
  const t = flatPage(B.pageText(a, 1 + (s * 37 + u * 101 + 1000) % 410)); pages++;
  let g = 0;
  for (let i = 0; i < t.length; i++) {
    const v = B.ALPHABET.indexOf(t[i]); counts[v]++;
    g = (g * 29 + v) % 14507145975869;   // 29^9: a rolling 9-gram, exact in a double
    if (i >= 8) { if (grams.has(g)) dup++; grams.add(g); }
  }
}
const perPage = (performance.now() - t0) / pages, total = pages * 3200, e = total / 29;
const chi = counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
ok(chi < 80, `symbols uniform over ${pages} nearby pages (χ² ${chi.toFixed(1)}, 28 d.o.f.)`);
ok(dup < 5, `no shared 9-character stretches (${dup} repeats among ${grams.size.toLocaleString()} ; ~0 expected)`);
console.log(`     ${perPage.toFixed(2)} ms per nearby page`);
