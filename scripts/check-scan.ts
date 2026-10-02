// Checks web/scan.js, the word finder, against a slow reference that applies the same rules to rendered page text.
// scripts/check-scan-gpu.ts then holds the GPU scanner to this one.
import { readFileSync } from 'node:fs';
import * as B from '../web/babel.js';
import { loadWords, scanBook } from '../web/scan.js';

const ok = (cond: unknown, what: string) => { if (!cond) { console.error('FAIL', what); process.exit(1); } console.log('ok  ', what); };
const words = loadWords(readFileSync(new URL('../web/words.txt', import.meta.url), 'utf8')), dict = new Set(words.list);
const isL = (ch: string | undefined) => !!ch && ch >= 'a' && ch <= 'z';

// runs of dictionary words joined by " " or ", ", bounded by non-letters; a trailing period belongs to the run
function reference(text: string, min: number) {
  const out: string[] = [];
  for (let i = 0; i < text.length;) {
    if (!isL(text[i]) || isL(text[i - 1])) { i++; continue; }
    let j = i, n = 0, end = i;
    for (;;) {
      let k = j; while (isL(text[k])) k++;
      if (!(k - j <= 10 && dict.has(text.slice(j, k)))) break;
      n++; end = k;
      if (text[k] === ' ' && isL(text[k + 1])) { j = k + 1; continue; }
      if (text[k] === ',' && text[k + 1] === ' ' && isL(text[k + 2])) { j = k + 2; continue; }
      if (text[k] === '.') end = k + 1;
      break;
    }
    if (n && end - i >= min) out.push(`${i}:${text.slice(i, end)}`);
    i = Math.max(i + 1, end);
  }
  return out;
}

let finds = 0, differ = 0;
const t0 = performance.now();
for (let t = 0; t < 8; t++) {
  const a = { floor: t * 3 - 9, unit: t * 17 - 60, shelf: t % 6, slot: (t * 5) % 32 };
  const got = scanBook(a, words, 5).map(f => `${f.page}/${f.at}:${f.text}`).sort();
  const want: string[] = [];
  for (let p = 1; p <= B.PAGES; p++) for (const r of reference(B.pageText(a, p).replace(/\n/g, ''), 5)) want.push(`${p}/${r}`);
  want.sort(); finds += want.length;
  if (got.join('|') !== want.join('|')) { differ++; console.error('differs at', a, { got: got.length, want: want.length }); }
}
ok(differ === 0, `scanner matches the text reference: 8 books, ${finds} finds of 5+ characters (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
ok(!dict.has('whore') && dict.has('hell') && dict.has('library'), 'word list: slurs left out, ordinary words in');

// A book that really says something, as the book of someone's life would: search() puts a long sentence on a page
// (unimaginably far away), and the scanner, reading that far book, must find the whole sentence as one find.
const clause = 'and the old man walked on through the long hall of books, and he did not stop to rest, ';
for (const n of [300, 3150]) {
  let s = ''; while (s.length + clause.length < n) s += clause;
  s = s.trimEnd().replace(/,$/, '') + '.';
  const r = B.search(s, { page: 7, at: 3200 - s.length, blank: true });
  const got = scanBook(r.address, words, 9).filter(f => f.page === 7);
  ok(got.length === 1 && got[0].text === s && got[0].len === s.length, `a ${s.length}-character sentence in a far book is one find`);
}
