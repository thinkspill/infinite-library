// Scans shelves for English: runs of dictionary words in the library's text (babel.js), read straight from the
// page streams with no strings or allocation per page. scan-gpu.js does the same on the GPU and must agree
// with this file exactly; scripts/check-scan.ts compares them.
//
// A find is a run of words separated by one space (or ", "), bounded by non-letters or the page's edge, and
// ending at the first thing that isn't a word. A trailing period belongs to it. Its rarity is how unlikely
// that exact string is at one spot in random text: 29^-length, times the chance of a non-letter either side.

import { ALPHABET, PAGES, SHELVES, SLOTS, STREAM, seedState, absorb, planBook, nearPlan, pageKey } from './babel.js';

// The page stream (babel.js step) runs inline below, about 15% faster than calling it; its constants come from
// babel.js, and scripts/check-stream.ts holds both inline copies (scanPage, nearPageSymbols) to babel.js's known
// answers (STREAM_VECTORS).
const { K, SYMBOLS, D_PG, XO_MUL1, XO_ROT1, XO_MUL2, XO_SHIFT, XO_ROT2 } = STREAM;
const MAXW = 10, RING = 4096;   // RING ≥ a page: a run can fill one
const ring = new Uint8Array(RING);   // the page's digits so far, to read a find's text back; one per worker
export const DEFAULT_MIN = 7;   // characters: about one find per metre of shelf

// Words as numbers: base 27 with a = 1, so a word of up to ten letters is an exact integer below 2^53.
// A 20-bit filter on a rolling 32-bit hash turns most non-words away before the Set lookup.
export function loadWords(text) {
  const set = new Set(), filter = new Uint32Array(1 << 15), list = [];
  for (const line of text.split('\n')) {
    const w = line.trim();
    if (!w || w[0] === '#' || !/^[a-z]{1,10}$/.test(w)) continue;
    let v = 0, h = 0;
    for (let i = 0; i < w.length; i++) { const d = w.charCodeAt(i) - 96; v = v * 27 + d; h = (Math.imul(h, 31) + d) | 0; }
    set.add(v); filter[h >>> 17] |= 1 << ((h >>> 12) & 31); list.push(w);
  }
  return { set, filter, list };
}

// finds on one page: pushes { page, at, len, words, text } onto out
function scanPage(s, add, page, words, min, out) {
  const { set, filter } = words;
  let a = s[0], b = s[1], c = s[2], d = s[3];
  let tl = 0, tv = 0, th = 0, ts = 0;            // token: length, value, hash, start
  let rw = 0, rs = 0, re = 0, pend = 0;          // run: words, start, end; pend 1 after " ", 2 after ",", 3 after ", "
  const flush = () => {
    if (rw && re - rs >= min) {
      let t = ''; for (let j = rs; j < re; j++) t += ALPHABET[ring[j & (RING - 1)]];
      out.push({ page: page + 1, at: rs, len: re - rs, words: rw, text: t });
    }
    rw = 0; pend = 0;
  };
  const endToken = (j, sep) => {
    if (tl <= MAXW && (filter[th >>> 17] >>> ((th >>> 12) & 31) & 1) && set.has(tv)) {
      if (!rw) rs = ts;
      rw++; re = j;
      if (sep === 26) pend = 1; else if (sep === 27) pend = 2; else { if (sep === 28) re = j + 1; flush(); }
    } else flush();
    tl = 0;
  };
  for (let j = 0; j < K; j++) {
    const m = Math.imul(b, XO_MUL1), x = Math.imul(m << XO_ROT1 | m >>> (32 - XO_ROT1), XO_MUL2) >>> 0, t = b << XO_SHIFT;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = d << XO_ROT2 | d >>> (32 - XO_ROT2);
    let g = Math.floor(x * SYMBOLS / 4294967296);
    if (j < add.length && add[j]) {   // a digit of the book's number: added, then absorbed into the stream (babel.js)
      const v = add[j]; g += v; if (g >= SYMBOLS) g -= SYMBOLS;
      s[0] = a; s[1] = b; s[2] = c; s[3] = d; absorb(s, v, j); a = s[0]; b = s[1]; c = s[2]; d = s[3];
    }
    ring[j & (RING - 1)] = g;
    if (g < 26) {
      if (!tl) { ts = j; tv = 0; th = 0; if (pend === 2) flush(); }
      if (tl < MAXW + 1) { tv = tv * 27 + g + 1; th = (Math.imul(th, 31) + g + 1) | 0; }
      tl++;
    } else if (tl) endToken(j, g);
    else if (pend === 2 && g === 26) pend = 3;
    else if (rw) flush();
  }
  if (tl) endToken(K, -1); else flush();
}

// Every find on one page (1-410) of one book: what the server uses to check a claimed find.
// For a nearby book (its scrambled number fits on page 1) only that page's key is worked out, not all 410: this is
// what the server runs for every claim.
export function scanPageOf(address, page, words, min = DEFAULT_MIN) {
  const out = [], near = nearPlan(address);
  if (near) {
    const key = pageKey(page === 1 ? EMPTY : near.acc1, page - 1);
    scanPage(seedState(key, D_PG, page - 1), page === 1 ? near.m : NONE, page - 1, words, min, out);
    return out;
  }
  const plan = planBook(address);
  scanPage(seedState(plan.keys[page - 1], D_PG, page - 1), plan.digits(page - 1), page - 1, words, min, out);
  return out;
}
const NONE = new Uint8Array(0), EMPTY = new Array(STREAM.ACC).fill(0);   // no digits; page 1's accumulators

// One page's symbols (0-28) as scanPage reads them. The ring keeps a whole page, so a scan for no words leaves the
// page in it. For scripts/check-stream.ts, which holds this copy of the stream to babel.js's known answers.
const NO_WORDS = { set: new Set(), filter: new Uint32Array(1 << 15) };
export function pageSymbolsOf(address, page) {
  scanPageOf(address, page, NO_WORDS, Infinity);
  return ring.slice(0, K);
}
// The first n symbols of a page (1-410) of a nearby book, from its nearPlan ({ m, acc1 }): scan-gpu.js reads its
// finds' text back with this. The same stream as scanPage, without the word finder: running scanPage for it took a
// quarter off the GPU scanner's speed, since every find is read back. check-stream.ts holds both to the known answers.
export function nearPageSymbols(near, page, n = K) {
  const s = seedState(pageKey(page === 1 ? EMPTY : near.acc1, page - 1), D_PG, page - 1), add = page === 1 ? near.m : NONE;
  const o = new Uint8Array(n);
  let a = s[0], b = s[1], c = s[2], d = s[3];
  for (let j = 0; j < n; j++) {
    const m = Math.imul(b, XO_MUL1), x = Math.imul(m << XO_ROT1 | m >>> (32 - XO_ROT1), XO_MUL2) >>> 0, t = b << XO_SHIFT;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = d << XO_ROT2 | d >>> (32 - XO_ROT2);
    let g = Math.floor(x * SYMBOLS / 4294967296);
    if (j < add.length && add[j]) {
      const v = add[j]; g += v; if (g >= SYMBOLS) g -= SYMBOLS;
      s[0] = a; s[1] = b; s[2] = c; s[3] = d; absorb(s, v, j); a = s[0]; b = s[1]; c = s[2]; d = s[3];
    }
    o[j] = g;
  }
  return o;
}

// Every find in one book, pages 1-410.
export function scanBook(address, words, min = DEFAULT_MIN) {
  const plan = planBook(address), out = [];
  for (let p = 0; p < PAGES; p++) scanPage(seedState(plan.keys[p], D_PG, p), plan.digits(p), p, words, min, out);
  return out;
}

// Every find on one shelf unit (6 shelves × 32 books) of one side's gallery (0 east, 1 west), best first.
export function scanUnit(floor, unit, words, min = DEFAULT_MIN, side = 0) {
  const finds = [];
  for (let shelf = 0; shelf < SHELVES; shelf++) for (let slot = 0; slot < SLOTS; slot++)
    for (const f of scanBook({ floor, unit, side, shelf, slot }, words, min)) finds.push({ floor, unit, side, shelf, slot, ...f });
  return finds.sort((x, y) => y.len - x.len || y.words - x.words);
}

// A scanner's finds for these units, best `keep` per unit, as finder.js wants them: [{ key: 'floor/unit', finds }].
export function byUnit(units, finds, keep) {
  const m = new Map(units.map(u => [`${u.floor}/${u.unit}`, []]));
  for (const f of finds) { const l = m.get(`${f.floor}/${f.unit}`); if (l && l.length < keep) l.push(f); }
  return [...m].map(([key, finds]) => ({ key, finds }));
}

// log10 of 1/P for a find: the "1 in 10^r" a player sees
export const rarity = f => f.len * Math.log10(29) + 2 * Math.log10(29 / 3);
