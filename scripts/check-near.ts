// Checks the chained library in web/babel.js: the scramble is a permutation, a one-digit change spreads like
// random text, every book reads back to its own shelf, search lands where it says and as close as the text's length
// allows, and nearby books (page 1 above all, where the book number's digits go) still look like unrelated noise.
// Run: node scripts/check-near.ts
import * as B from '../web/babel.js';
const N = B;

let failed = 0;
const ok = (cond: unknown, what: string) => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
const same = (a: any, b: any) => (a.side || 0) === (b.side || 0) && a.shelf === b.shelf && a.slot === b.slot && B.bigEqual(a.floor, b.floor) && B.bigEqual(a.unit, b.unit);
const flat = (t: string) => t.replace(/\n/g, '');
const far = (a: any) => Math.max(B.log10Big(B.bigFromNumber(0)), B.log10Big(typeof a.floor === 'number' ? B.bigFromNumber(a.floor) : a.floor),
  B.log10Big(typeof a.unit === 'number' ? B.bigFromNumber(a.unit) : a.unit));
const where = (a: any) => `floor ${B.describeBig(a.floor).split(' (')[0]}, unit ${B.describeBig(a.unit).split(' (')[0]}, shelf ${a.shelf + 1}, book ${a.slot + 1}`;
const digitsOf = (v: number) => { const d: number[] = []; while (v) { d.push(v % 29); v = Math.floor(v / 29); } return Uint8Array.from(d); };
const key = (d: Uint8Array) => Array.from(d).join(',');

console.log('\nThe scramble');
for (const k of [1, 2, 3]) {
  const seen = new Set<string>(); let back = true;
  for (let v = 29 ** (k - 1); v < 29 ** k; v++) {
    const d = digitsOf(v), s = N.scramble(d);
    if (s.length !== k) back = false;
    seen.add(key(s)); if (key(N.scramble(s, true)) !== key(d)) back = false;
  }
  ok(back && seen.size === 28 * 29 ** (k - 1), `${k}-digit numbers: a permutation of all ${(28 * 29 ** (k - 1)).toLocaleString()}, undone exactly`);
}
{
  let back = true;
  for (const k of [7, 50, 3200, 20000]) for (let i = 0; i < 3; i++) {
    const d = Uint8Array.from({ length: k }, (_, j) => j === k - 1 ? 1 + (i * 7 + k) % 28 : (j * 31 + i * 17 + k) % 29), s = N.scramble(d);
    if (s.length !== k || key(N.scramble(s, true)) !== key(d)) back = false;
  }
  ok(back, '7-, 50-, 3,200- and 20,000-digit numbers keep their length and come back exactly');
}

// Spread: change one digit and see how much changes. In random text a symbol differs from another random symbol
// 28 times in 29 (96.6%); anything well under that is structure leaking through.
let rng = 12345;
const rand = (n: number) => { rng = (Math.imul(rng, 1103515245) + 12345) >>> 0; return Math.floor(rng / 4294967296 * n); };
const RANDOM = 28 / 29;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
function scrambleSpread(k: number, samples: number) {   // one digit of the book number changed: share of the scrambled digits that change
  let changed = 0, total = 0; const perDigit = new Array(k).fill(0);
  for (let t = 0; t < samples; t++) {
    const d = Uint8Array.from({ length: k }, (_, j) => j === k - 1 ? 1 + rand(28) : rand(29)), e = Uint8Array.from(d), i = rand(k);
    e[i] = i === k - 1 ? 1 + (e[i] - 1 + 1 + rand(27)) % 28 : (e[i] + 1 + rand(28)) % 29;
    const a = N.scramble(d), b = N.scramble(e);
    for (let j = 0; j < k; j++) if (a[j] !== b[j]) { changed++; perDigit[j]++; }
    total += k;
  }
  return { mean: changed / total, worst: Math.min(...perDigit) / samples };
}
console.log('\nSpread in the scramble (one digit of a book number changed; the books around the spawn have 1-6 digits)');
for (const k of [4, 5, 6, 8, 12]) {
  rng = 777 + k; const r = scrambleSpread(k, 1500);
  ok(Math.abs(r.mean - RANDOM) < 0.02 && r.worst > RANDOM - 0.04,
    `${k}-digit numbers: ${pct(r.mean)} of the scrambled digits change, the least-changed digit ${pct(r.worst)} (random ${pct(RANDOM)})`);
}

console.log('\nSpread in the text (one digit of the scrambled number changed)');
{
  const diff = (x: string, y: string) => { let n = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++; return n / x.length; };
  const books: [string, Uint8Array][] = [
    ['a book at the spawn', N.scramble(B.bookNumber({ floor: 0, unit: 0, shelf: 3, slot: 9 })!)],
    ['a book 40 m away', N.scramble(B.bookNumber({ floor: 2, unit: 40, shelf: 1, slot: 20 })!)],
    ['the fox sentence\'s book', N.scramble(N.search('the quick brown fox jumps over the lazy dog.').book)],
  ];
  for (const [what, m] of books) {
    let sameBefore = true, after = 0, afterN = 0, others = 0, othersN = 0;
    for (const j of [0, Math.floor(m.length / 2), m.length - 1, m.length, m.length + 400, 2000]) {   // inside the number, and past its end
      const e = new Uint8Array(Math.max(m.length, j + 1)); e.set(m); e[j] = (e[j] + 1 + rand(28)) % 29;
      const ra = N.readerOfScrambled(m), rb = N.readerOfScrambled(e), pa = flat(ra(1)), pb = flat(rb(1));
      if (pa.slice(0, j) !== pb.slice(0, j)) sameBefore = false;
      after += diff(pa.slice(j + 1), pb.slice(j + 1)) * (3199 - j); afterN += 3199 - j;
      for (const p of [2, 205, 410]) { others += diff(flat(ra(p)), flat(rb(p))); othersN++; }
    }
    ok(sameBefore && Math.abs(after / afterN - RANDOM) < 0.02 && Math.abs(others / othersN - RANDOM) < 0.02,
      `${what} (${m.length}-digit number): page 1 after the changed spot ${pct(after / afterN)} different, pages 2, 205, 410 ${pct(others / othersN)}; before it, unchanged`);
  }
  // a digit on page 2 of the number leaves page 1 alone and changes page 2 from that spot on, and every later page
  const m = N.scramble(N.search('a short stay in hell').book), e = new Uint8Array(5000); e.set(m); e[4999] = 7;
  const ra = N.readerOfScrambled(m), rb = N.readerOfScrambled(e), at = 4999 - 3200;
  const p2a = flat(ra(2)), p2b = flat(rb(2));
  ok(ra(1) === rb(1) && p2a.slice(0, at) === p2b.slice(0, at) && Math.abs(diff(p2a.slice(at + 1), p2b.slice(at + 1)) - RANDOM) < 0.03 && Math.abs(diff(flat(ra(3)), flat(rb(3))) - RANDOM) < 0.03,
    `a digit at position 5,000 of the number: page 1 the same, page 2 the same up to column ${at + 1} and ${pct(diff(p2a.slice(at + 1), p2b.slice(at + 1)))} different after, page 3 ${pct(diff(flat(ra(3)), flat(rb(3))))}`);
}

console.log('\nWhole books read back to their own shelf');
for (const a of [{ floor: 0, unit: 0, shelf: 0, slot: 0 }, { floor: 0, unit: 4, shelf: 2, slot: 7 }, { floor: -3, unit: 1000, shelf: 5, slot: 31 },
  { floor: 123456789, unit: -987654321, shelf: 1, slot: 0 }]) {
  const read = N.bookReader(a), pages = Array.from({ length: B.PAGES }, (_, i) => read(i + 1));
  ok(same(N.addressOfPages(pages), a), `floor ${a.floor}, unit ${a.unit}, shelf ${a.shelf + 1}, book ${a.slot + 1}: all 410 pages lead back to it`);
}

console.log('\nSearch: where it lands');
const rows: string[] = [];
for (const q of ['library', 'hello world', 'a short stay in hell', 'the quick brown fox jumps over the lazy dog.',
  'it was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief.']) {
  const t0 = performance.now(), r = N.search(q), ms = performance.now() - t0;
  const read = N.bookReader(r.address), at = (r.line - 1) * 80 + r.col - 1;
  ok(flat(read(r.page)).slice(at, at + q.length) === q && read(r.page) === r.text, `${JSON.stringify(q.length > 40 ? q.slice(0, 40) + '…' : q)} (${q.length} chars) reads back from ${where(r.address)}`);
  const pages = Array.from({ length: B.PAGES }, (_, i) => read(i + 1));
  ok(same(N.addressOfPages(pages), r.address), '  and that whole book leads back to the same shelf');
  rows.push(`  ${String(q.length).padStart(4)} chars   ~10^${far(r.address).toFixed(1)}   ${B.describeWalk(r.address)} on foot   (${ms.toFixed(0)} ms)`);
}
console.log('\n  distance from home (larger of floor and unit):'); for (const r of rows) console.log(r);
console.log('');
{
  const q = 'hello world', r2 = N.search(q, { page: 2 }), r3 = N.search(q, { at: 1000 }), rb = N.search(q, { blank: true });
  const reads = (r: any) => flat(N.bookReader(r.address)(r.page)).slice((r.line - 1) * 80 + r.col - 1).startsWith(q);
  ok(reads(r2) && reads(r3) && reads(rb) && flat(rb.text).replace(q, '').trim() === '', `placed elsewhere it still reads back, only farther: page 2 ~10^${far(r2.address).toFixed(0)}, column 1,001 ~10^${far(r3.address).toFixed(0)}, blank page ~10^${far(rb.address).toFixed(0)}`);
  for (const [opts, what] of [[{ page: 2.5 }, 'page 2.5'], [{ at: -1 }, 'at -1'], [{ at: 3195 }, 'past the page end']] as [any, string][]) {
    let threw = false; try { N.search(q, opts); } catch (e) { threw = e instanceof RangeError; }
    ok(threw, `search rejects ${what}`);
  }
}

console.log('\nSearch finds books you can walk to');
{
  let found = 0, tried = 0, shortest = Infinity;
  for (let s = 0; s < 192; s += 9) {
    const a = { floor: 1, unit: 6, shelf: s >> 5, slot: s & 31 }, line = N.pageText(a, 1).split('\n')[0];
    tried++; if (same(N.search(line).address, a)) found++;
    for (let n = 1; n <= 80; n++) if (same(N.search(line.slice(0, n)).address, a)) { shortest = Math.min(shortest, n); break; }
  }
  ok(found === tried, `the first line of page 1 of ${tried} books on floor 1, unit 6 searches back to that exact book`);
  console.log(`     (as few as ${shortest} characters of it is enough: the book's number is that short)`);
}

console.log('\nNearby books still look like noise');
{
  const counts = new Array(29).fill(0), grams = new Set<number>(); let pages = 0, dup = 0;
  const t0 = performance.now();
  for (let u = -2; u <= 2; u++) for (let s = 0; s < 192; s++) {
    const a = { floor: 0, unit: u, shelf: s >> 5, slot: s & 31 }, read = N.bookReader(a);
    for (const p of [1, 2 + (s * 37 + u * 101 + 1000) % 409]) {   // page 1 is where the structure would show; the other is never page 1
      const t = flat(read(p)); pages++;
      let g = 0;
      for (let i = 0; i < t.length; i++) {
        const v = B.ALPHABET.indexOf(t[i]); counts[v]++;
        g = (g * 29 + v) % 14507145975869;
        if (i >= 8) { if (grams.has(g)) dup++; grams.add(g); }
      }
    }
  }
  const ms = (performance.now() - t0) / pages, e = pages * 3200 / 29, chi = counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
  ok(chi < 80, `symbols uniform over ${pages} nearby pages, half of them page 1 (χ² ${chi.toFixed(1)}, 28 d.o.f.)`);
  const expect = grams.size ** 2 / 2 / 29 ** 9;   // pairs of stretches that match by chance in random text
  ok(dup < 3 * expect + 5, `no shared 9-character stretches beyond chance (${dup} repeats among ${grams.size.toLocaleString()}; ~${expect.toFixed(1)} expected at random)`);
  console.log(`     ${ms.toFixed(2)} ms per nearby page, including the book's setup`);
  // the odometer this design has to avoid. Along a shelf: how often the next book's page 1 starts one letter on
  // (the spawn shelf, whose numbers have one digit, once read j k l m n o p…)
  let worst = 0, shelves = 0;
  for (const [f, u] of [[0, 0], [0, -1], [-1, 0], [0, 1], [2, 5]]) for (let sh = 0; sh < 6; sh++) {
    let runs = 0; shelves++;
    for (let sl = 0; sl < 31; sl++) {
      const x = B.ALPHABET.indexOf(N.pageText({ floor: f, unit: u, shelf: sh, slot: sl }, 1)[0]), y = B.ALPHABET.indexOf(N.pageText({ floor: f, unit: u, shelf: sh, slot: sl + 1 }, 1)[0]);
      if (y === (x + 1) % 29) runs++;
    }
    worst = Math.max(worst, runs);
  }
  ok(worst <= 5, `no shelf at the spawn counts up: at most ${worst} of a shelf's 31 next books start one letter on (~1 by chance, 25 before the fix), ${shelves} shelves`);
  // and neighbours' page 1 starting alike
  const common = (x: string, y: string) => { let i = 0; while (i < x.length && x[i] === y[i]) i++; return i; };
  for (const [what, b] of [['the next book on the shelf', (a: any) => ({ ...a, slot: a.slot + 1 })], ['the same spot one floor up', (a: any) => ({ ...a, floor: a.floor + 1 })],
    ['the same spot one metre on', (a: any) => ({ ...a, unit: a.unit + 1 })]] as [string, (a: any) => any][]) {
    let pairs = 0, first = 0, longest = 0;
    for (let u = 0; u < 10; u++) for (let s = 0; s < 31; s++) {
      const a = { floor: 0, unit: u, shelf: s >> 5, slot: s & 31 }, c = common(N.pageText(a, 1), N.pageText(b(a), 1));
      pairs++; if (c) first++; longest = Math.max(longest, c);
    }
    ok(first < pairs / 29 * 3 + 5 && longest < 5, `page 1 vs ${what}: ${first} of ${pairs} share a first character (~${Math.round(pairs / 29)} by chance), longest shared start ${longest}`);
  }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
