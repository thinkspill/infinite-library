// Is search() finding books that are already on the shelves, or making them up? This runs the proofs in
// web/proofs.js (the same ones the page's "How it works" dialog runs) and prints each step. Every proof reads books
// only through the ordinary reader (an address in, pages out, no text from anywhere else).
// Run: node scripts/prove-search.ts
import { readFileSync } from 'node:fs';
import { describeBig, log10Big, bigFromNumber } from '../web/babel.js';
import { scanPageOf, loadWords } from '../web/scan.js';
import { proveWalk, proveAny, proveBook, proveEdit, proveName, readBook } from '../web/proofs.js';

const words = loadWords(readFileSync(new URL('../web/words.txt', import.meta.url), 'utf8'));
const coord = (v: any) => { const b = typeof v === 'number' ? bigFromNumber(v) : v, d = describeBig(b).split(' (')[0]; return d.includes('×10^') ? `~10^${Math.round(log10Big(b)).toLocaleString('en-US')}` : d; };
const where = (a: any) => `${a.side ? 'west' : 'east'} side, floor ${coord(a.floor)}, unit ${coord(a.unit)}, shelf ${a.shelf + 1}, book ${a.slot + 1}`;
let failed = 0;

// The console adapter: the proof's steps, one a line, then its verdict as ok/FAIL.
function show(r: any) {
  if (r.error) { failed++; console.log(`FAIL ${r.error}`); return; }
  for (const s of r.steps) {
    const v = s.page ? '\n       ' + (s.page.text.slice(0, s.page.from) + '[' + s.page.text.slice(s.page.from, s.page.to) + ']' + s.page.text.slice(s.page.to)).replace(/\n/g, '\n       ')
      : s.address ? where(s.address) : s.quote ? JSON.stringify(s.text) : s.text;
    console.log(`     ${s.label}: ${v}${s.ms != null ? ` (${s.ms.toFixed(0)} ms)` : ''}`);
  }
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.verdict}`);
}

const near = { floor: 0, unit: 3, side: 0, shelf: 2, slot: 5 }, nearPages = readBook(near);

// 1. A book you can walk to: read all of it, run reading backwards, and you get its own shelf back.
console.log('\n1. A nearby book, read and run backwards');
show(proveBook(near, nearPages));

// 2. The map has no slack: change one letter and that book lives somewhere else entirely.
console.log('\n2. The same book with one letter changed');
show(proveEdit(near, 200, nearPages));

// 3. Its first line, searched for, is that same book, by the same book number.
console.log('\n3. A nearby book found by its first line');
show(proveWalk({ floor: -2, unit: -150, side: 1, shelf: 4, slot: 31 }));

// 4. search(): take only the address, read that shelf the ordinary way, and the text is there; then read the whole
//    book from the shelf and run it backwards.
console.log('\n4. A searched book, read from its address alone');
for (const q of [' hello world ', 'the quick brown fox jumps over the lazy dog.']) {
  console.log(`  ${JSON.stringify(q)}`);
  const r = proveAny(q); show(r); if (!r.claim) continue;
  show(proveBook(r.claim.address));
  // The phrase finder doesn't use the reader: it runs the raw page streams (scan.js). It sees the text too, when the
  // text is bounded by spaces or the page edge (otherwise its ends run into the letters beside it).
  const finds = scanPageOf(r.claim.address, r.claim.page, words).map((f: any) => f.text).filter((t: string) => q.includes(t));
  if (q.startsWith(' ') && q.endsWith(' ')) { const ok = finds.includes(q.trim()); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} the phrase finder, reading the raw streams, reports ${JSON.stringify(finds)}`); }
  else console.log(`     no spaces around it: it starts at the page's edge, and its end runs on into whatever follows. The phrase finder reports ${JSON.stringify(finds)}`);
}

// 5. Your book: a name and nothing else, 410 pages of it, on its own shelf.
console.log('\n5. A name’s own book');
show(proveName('Soren Kierkegaard'));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
