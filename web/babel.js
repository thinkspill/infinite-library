// The library's text. Every possible 410-page book is on some shelf, exactly once.
//
// This module is shared: the page imports it in the browser, and the Worker imports it for agents, so the two
// read identical books by construction. It uses only 32-bit integer and exact float arithmetic (BigInt only to
// print and parse decimal), so a page near the spawn costs a few thousand PRNG steps.
//
// A book is L = 410 × 40 × 80 symbols, i.e. a base-29 number with L digits: there are 29^L books.
//   address ⇄ book number: floor and unit are zig-zagged to naturals, their base-29 digits interleaved
//     (unit in even places, floor in odd), then × 2 + side, then × 192 + (shelf × 32 + slot). A bijection
//     Z × Z × 2 × 192 ⇄ N: the two galleries facing each other across the shaft (side 0 east, 1 west) hold
//     different books,
//     so small addresses are small numbers, and numbers ≥ 29^L are shelves past the end of the library.
//     Every unit has shelves (the stairs run along the railing), so every book is on a shelf that exists.
//   book number ⇄ scrambled number: a permutation of the numbers with k digits among themselves (a shuffled table
//     up to 3 digits, an 8-round Feistel network over the digits above that). Neighbouring shelves get unrelated
//     numbers, and a short number stays short.
//   scrambled number ⇄ text, chained: page p is a keyed xoshiro128** stream, its key a hash of the number's digits
//     before page p (and p). Each of the number's digits is added to the next symbol, mod 29, and then absorbed
//     into the stream's state, so every later symbol depends on it. Backwards, each symbol's mask depends only on
//     digits already recovered, so reading runs backwards exactly, one symbol at a time.
// search() runs it backwards: it writes the text at the top of page 1 (or where asked), leaves everything else as
// it would fall, and reports whose shelf that is. Every character before the text costs a digit of the number, so
// the top of page 1 is the nearest place: an n-character text lands about 10^(0.73 n) floors and metres out.
// That is about where its nearest copy would be in a random library: a word is down the gallery, a sentence is
// unimaginably far, and a whole book (the one with your life in it) is about 10^959,000 floors away.

export const ALPHABET = 'abcdefghijklmnopqrstuvwxyz ,.';
export const PAGES = 410, LINES = 40, COLS = 80, SHELVES = 6, SLOTS = 32;
// Bumped whenever the text at an address changes, so the server can retire finds made in another library.
export const LIBRARY = 'sides-1';
// The two galleries, facing each other across the shaft. An address's side is 0 or 1 (missing means 0).
export const SIDES = ['east', 'west'];
const K = LINES * COLS, L = PAGES * K, PER_UNIT = SHELVES * SLOTS;
const D_SIG = 0x73, D_TAB = 0x74, ROUNDS = 8, TABLE_MAX = 3;

// ---------------------------------------------------------------- the page stream's constants
// Every number the page stream is made of, owned here. scan.js runs the stream inline for speed and scan-gpu.js runs
// it in WGSL; both take each of these from STREAM (the WGSL interpolates every one), and STREAM_VECTORS below, frozen
// from this code, holds all three to the same output (scripts/check-stream.ts, scripts/check-scan-gpu.ts).
const SYMBOLS = ALPHABET.length;                                      // 29: a stream symbol is 0-28
const D_PG = 0x70;                                                    // the page stream's domain
const QR_ROT = [16, 12, 8, 7];                                        // ChaCha quarter round rotations
const HASH_IV = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];     // ChaCha's "expand 32-byte k"
const HASH_WORD_ROUNDS = 2, HASH_FINAL_ROUNDS = 8;                    // quarter rounds after each word, and at the end
const SEED_XOR = 0x9e3779b9, SEED_ROUNDS = 8;                         // seedState: key[3] ^ SEED_XOR, then rounds
const ABSORB_MUL = 0x9e3779b1, ABSORB_ROUNDS = 2;                     // absorb: s0 ^= v × ABSORB_MUL ^ j, then rounds
const XO_MUL1 = 5, XO_ROT1 = 7, XO_MUL2 = 9, XO_SHIFT = 9, XO_ROT2 = 11;   // xoshiro128**: rotl(b × 5, 7) × 9, t = b << 9, rotl(d, 11)
// Page keys: five polynomial hashes of the scrambled number's digits below p·K (value mod primes just under 2^26,
// so every product is exact in a double, and zero digits past the end change nothing), with p.
const PRIMES = [67108859, 67108837, 67108819, 67108777, 67108763];
const ROOTS = [40009711, 51772873, 23305661, 61137979, 9876413];
const ACC = PRIMES.length;                                            // a page key hashes ACC accumulators and the page

// ---------------------------------------------------------------- mixing
const [R0, R1, R2, R3] = QR_ROT;
const rotl = (x, r) => x << r | x >>> (32 - r);
function qr(s) {   // ChaCha quarter round
  let a = s[0], b = s[1], c = s[2], d = s[3];
  a = a + b | 0; d = rotl(d ^ a, R0); c = c + d | 0; b = rotl(b ^ c, R1);
  a = a + b | 0; d = rotl(d ^ a, R2); c = c + d | 0; b = rotl(b ^ c, R3);
  s[0] = a; s[1] = b; s[2] = c; s[3] = d;
}
function hash(words, domain) {
  const s = [HASH_IV[0], HASH_IV[1] ^ domain, HASH_IV[2], HASH_IV[3] ^ words.length];
  for (let i = 0; i < words.length; i++) { s[0] ^= words[i]; for (let r = 0; r < HASH_WORD_ROUNDS; r++) qr(s); }
  for (let r = 0; r < HASH_FINAL_ROUNDS; r++) qr(s);
  return s;
}
export function seedState(key, domain, index) {
  const s = [key[0] ^ domain, key[1] ^ index, key[2], key[3] ^ SEED_XOR];
  for (let r = 0; r < SEED_ROUNDS; r++) qr(s);
  if (!(s[0] | s[1] | s[2] | s[3])) s[0] = 1;
  return s;
}
// xoshiro128** on a 4-word state: the output word for state word b, then the step itself
const scrambledOut = b => Math.imul(rotl(Math.imul(b, XO_MUL1), XO_ROT1), XO_MUL2) >>> 0;
// the next symbol, 0-28
function step(s) {
  const x = scrambledOut(s[1]), t = s[1] << XO_SHIFT;
  s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], XO_ROT2);
  return Math.floor(x * SYMBOLS / 4294967296);
}
// a digit v (≠ 0) of the number at place j on a page goes into the stream's state
export function absorb(s, v, j) { s[0] ^= Math.imul(v, ABSORB_MUL) ^ j; for (let r = 0; r < ABSORB_ROUNDS; r++) qr(s); }
function symbols(key, domain, index, n) { const s = seedState(key, domain, index), o = new Uint8Array(n); for (let j = 0; j < n; j++) o[j] = step(s); return o; }
function pack(d) {   // six base-29 digits per word (29^6 < 2^32): injective for a given length
  const w = new Array(Math.ceil(d.length / 6)).fill(0);
  for (let i = d.length - 1; i >= 0; i--) w[(i / 6) | 0] = w[(i / 6) | 0] * 29 + d[i];
  return w.map(x => x >>> 0);
}
function render(digits) {
  const lines = new Array(LINES);
  for (let l = 0; l < LINES; l++) { let s = ''; for (let c = 0; c < COLS; c++) s += ALPHABET[digits[l * COLS + c]]; lines[l] = s; }
  return lines.join('\n');
}
const toDigits = s => Uint8Array.from(String(s).replace(/\n/g, ''), ch => {
  const v = ALPHABET.indexOf(ch); if (v < 0) throw new RangeError(`the library has no ${JSON.stringify(ch)}; only a-z, space, comma, period`);
  return v;
});


// ---------------------------------------------------------------- the scramble: numbers of k digits among themselves
// Up to 3 digits a Feistel network is too small to mix (with one digit, one half is empty and it is only a shift:
// the shelf at the spawn would read a, b, c, d…), so those classes are a shuffled table: 28·29^(k−1) entries,
// shuffled once by a keyed stream (Fisher-Yates), 24,389 numbers in all.
const tables = [];
function table(k) {
  if (tables[k]) return tables[k];
  const lo = 29 ** (k - 1), size = 28 * lo, fwd = new Uint32Array(size), inv = new Uint32Array(size);
  for (let i = 0; i < size; i++) fwd[i] = i;
  const s = seedState(hash([k], D_TAB), D_TAB, k);
  for (let i = size - 1; i > 0; i--) {   // a uniform j in 0..i from 32 bits: bias at most size / 2^32
    const x = scrambledOut(s[1]); step(s);
    const j = Math.floor(x * (i + 1) / 4294967296), t = fwd[i]; fwd[i] = fwd[j]; fwd[j] = t;
  }
  for (let i = 0; i < size; i++) inv[fwd[i]] = i;
  return (tables[k] = { lo, fwd, inv });
}
// One pass of a Feistel network over k digits: low half A (ceil(k/2) digits), high half B. Even rounds add F(B)
// to A, odd rounds add F(A) to B, digit-wise mod 29; F is a stream keyed by the other half, the round and k.
function feistel(d, k, inverse) {
  const h = Math.ceil(k / 2), A = d.slice(0, h), B = d.slice(h);
  for (let i = 0; i < ROUNDS; i++) {
    const r = inverse ? ROUNDS - 1 - i : i, [to, from] = r % 2 ? [B, A] : [A, B];
    const f = symbols(hash([...pack(from), r, k], D_SIG), D_SIG, r, to.length);
    for (let j = 0; j < to.length; j++) to[j] = (to[j] + (inverse ? 29 - f[j] : f[j])) % 29;
  }
  const o = new Uint8Array(k); o.set(A); o.set(B, h); return o;
}
// A k-digit number ⇄ a k-digit number. Above the tables, cycle walking keeps the top digit non-zero (so the image
// stays in range): about 1.04 passes on average.
export function scramble(n, inverse = false) {
  n = trim(n); const k = n.length;
  if (!k) return n;
  if (k <= TABLE_MAX) {
    const t = table(k); let v = 0; for (let i = k - 1; i >= 0; i--) v = v * 29 + n[i];
    let w = (inverse ? t.inv : t.fwd)[v - t.lo] + t.lo; const o = new Uint8Array(k);
    for (let i = 0; i < k; i++) { o[i] = w % 29; w = Math.floor(w / 29); }
    return o;
  }
  let d = Uint8Array.from(n);
  do d = feistel(d, k, inverse); while (d[k - 1] === 0);
  return d;
}

// ---------------------------------------------------------------- page keys
// Page p's key: the hash of ACC accumulators (PRIMES, ROOTS above) and p.
function powmod(b, e, p) { let r = 1; for (b %= p; e > 0; e = Math.floor(e / 2)) { if (e & 1) r = r * b % p; b = b * b % p; } return r; }
function prefixHash() {
  const acc = new Array(ACC).fill(0), pw = new Array(ACC).fill(1);
  return {
    acc,
    add(block) {   // a page's worth of the number (K digits; fewer, or none, are padded with zeros)
      const n = block ? block.length : 0;
      for (let l = 0; l < ACC; l++) {
        const p = PRIMES[l], r = ROOTS[l]; let a = acc[l], w = pw[l];
        for (let j = 0; j < n; j++) { const v = block[j]; if (v) a = (a + v * w) % p; w = w * r % p; }
        acc[l] = a; pw[l] = n === K ? w : w * powmod(r, K - n, p) % p;
      }
    },
  };
}
const pageKey = (acc, page) => hash([...acc, page], D_PG);   // page 0-409

// ---------------------------------------------------------------- one page, forwards and backwards
// m: this page's digits of the scrambled number (K, or fewer: the rest are zero) → the page's symbols
function writePage(key, page, m) {
  const s = seedState(key, D_PG, page), out = new Uint8Array(K);
  for (let j = 0; j < K; j++) {
    const v = j < m.length ? m[j] : 0;
    out[j] = (step(s) + v) % SYMBOLS;
    if (v) absorb(s, v, j);
  }
  return out;
}
// symbols → this page's digits. want(j) is the symbol place j must have, or -1 for whatever the stream gives (a zero digit).
function readPage(key, page, want) {
  const s = seedState(key, D_PG, page), m = new Uint8Array(K);
  for (let j = 0; j < K; j++) {
    const g = step(s), c = want(j), v = c < 0 ? 0 : (c - g + SYMBOLS) % SYMBOLS;
    m[j] = v;
    if (v) absorb(s, v, j);
  }
  return m;
}

// ---------------------------------------------------------------- big naturals as base-29 digit arrays
// A Big is { neg, d } with d little-endian base-29 digits and no leading zeros (0 is d = []).
const trim = d => { let n = d.length; while (n && !d[n - 1]) n--; return n === d.length ? d : d.subarray(0, n); };
export function bigFromNumber(v) {
  if (!Number.isSafeInteger(v)) throw new RangeError('not a safe integer');
  const neg = v < 0, d = []; v = Math.abs(v);
  while (v > 0) { const r = v % 29; d.push(r); v = (v - r) / 29; }
  return { neg, d: Uint8Array.from(d) };
}
export function bigToNumber(b) {   // null when it is not a safe integer
  if (b.d.length > 11) return null;
  let v = 0; for (let i = b.d.length - 1; i >= 0; i--) v = v * 29 + b.d[i];
  return Number.isSafeInteger(v) ? (b.neg && v ? -v : v) : null;
}
function mulAdd(d, m, a) {   // d × m + a, small m and a
  const o = new Uint8Array(d.length + 4); let carry = a;
  for (let i = 0; i < o.length; i++) { const t = (i < d.length ? d[i] : 0) * m + carry, x = (t / 29) | 0; o[i] = t - x * 29; carry = x; }
  return trim(o);
}
// Division by the two divisors we need, each with a constant so the JIT turns it into a multiply: these walk
// a million digits when search() turns a book number back into an address.
function div192(d) {   // [quotient, remainder]
  const q = new Uint8Array(d.length); let r = 0, i = d.length - 1;
  for (; i >= 2; i -= 3) {   // three digits a step: 192 × 29³ fits an int32
    const t = r * 24389 + d[i] * 841 + d[i - 1] * 29 + d[i - 2], x = (t / 192) | 0; r = t - x * 192;
    const a = (x / 841) | 0, b = x - a * 841, c = (b / 29) | 0; q[i] = a; q[i - 1] = c; q[i - 2] = b - c * 29;
  }
  for (; i >= 0; i--) { const t = r * 29 + d[i], x = (t / 192) | 0; q[i] = x; r = t - x * 192; }
  return [trim(q), r];
}
function half(d) {
  const q = new Uint8Array(d.length); let r = 0, i = d.length - 1;
  for (; i >= 2; i -= 3) {
    const t = r * 24389 + d[i] * 841 + d[i - 1] * 29 + d[i - 2], x = t >> 1; r = t & 1;
    const a = (x / 841) | 0, b = x - a * 841, c = (b / 29) | 0; q[i] = a; q[i - 1] = c; q[i - 2] = b - c * 29;
  }
  for (; i >= 0; i--) { const t = r * 29 + d[i]; q[i] = t >> 1; r = t & 1; }
  return trim(q);
}
function addOne(d) { const o = new Uint8Array(d.length + 1); o.set(d); let i = 0; while (o[i] === 28) o[i++] = 0; o[i]++; return trim(o); }
const zig = b => b.neg && b.d.length ? subOne(mulAdd(b.d, 2, 0)) : mulAdd(b.d, 2, 0);
function subOne(d) { const o = Uint8Array.from(d); let i = 0; while (o[i] === 0) o[i++] = 28; o[i]--; return trim(o); }
function unzig(d) {   // parity of a base-29 number is the parity of its digit sum
  let s = 0; for (let i = 0; i < d.length; i++) s += d[i];
  return s & 1 ? { neg: true, d: half(addOne(d)) } : { neg: false, d: half(d) };
}
const asBig = v => typeof v === 'number' ? bigFromNumber(v) : v;
// b + n for a safe integer n: for walking about near a far address (one floor or one unit at a time).
export function bigAddSmall(b, n) {
  if (!Number.isSafeInteger(n)) throw new RangeError('not a safe integer');
  const v = bigToNumber(b);
  if (v !== null && Number.isSafeInteger(v + n)) return bigFromNumber(v + n);
  // either the signs agree, or |b| > 2^53 > |n|: either way the sign stays b's
  const o = new Uint8Array(Math.max(b.d.length, 11) + 2); o.set(b.d);   // 29^11 > 2^53
  let c = Math.abs(n);
  if (b.neg === n < 0) for (let i = 0; c; i++) { const t = o[i] + c % 29; c = Math.floor(c / 29) + (t >= 29 ? 1 : 0); o[i] = t % 29; }
  else for (let i = 0; c; i++) { let t = o[i] - c % 29; c = Math.floor(c / 29); if (t < 0) { t += 29; c++; } o[i] = t; }
  return { neg: b.neg, d: trim(o) };
}
export const bigEqual = (a, b) => { a = asBig(a); b = asBig(b); return a.neg === b.neg && a.d.length === b.d.length && a.d.every((x, i) => x === b.d[i]); };


// Book number (flat digits) for an address, or null if that shelf lies past the end of the library.
export function bookNumber(a) {
  const f = zig(asBig(a.floor)), u = zig(asBig(a.unit)), m = new Uint8Array(2 * Math.max(f.length, u.length));
  for (let t = 0; t < u.length; t++) m[2 * t] = u[t];
  for (let t = 0; t < f.length; t++) m[2 * t + 1] = f[t];
  const n = mulAdd(mulAdd(trim(m), 2, a.side ? 1 : 0), PER_UNIT, a.shelf * SLOTS + a.slot);
  return n.length > L ? null : n;
}
export function addressOf(n) {
  const [q, s] = div192(trim(n));
  let parity = 0; for (let i = 0; i < q.length; i++) parity += q[i];   // base 29 is odd: a number's parity is its digit sum's
  const side = parity & 1, m = side ? half(subOne(q)) : half(q), half_ = Math.ceil(m.length / 2);
  const u = new Uint8Array(half_), f = new Uint8Array(half_);
  for (let i = 0; i < m.length; i += 2) u[i >> 1] = m[i];
  for (let i = 1; i < m.length; i += 2) f[i >> 1] = m[i];
  return { floor: unzig(trim(f)), unit: unzig(trim(u)), side, shelf: Math.floor(s / SLOTS), slot: s % SLOTS };
}

// ---------------------------------------------------------------- public
// Everything per book, once: the scrambled number m, page p's digits of it, and every page's key.
// `a` is an address, or a book number (digits, as search() returns it).
export function planBook(a) {
  const n = a instanceof Uint8Array ? trim(a) : bookNumber(a);
  if (!n) throw new RangeError('that shelf lies past the end of the library');
  return planScrambled(scramble(n));
}
function planScrambled(m) {
  const none = new Uint8Array(0), h = prefixHash(), keys = new Array(PAGES);
  const digits = p => p * K < m.length ? m.subarray(p * K, Math.min(m.length, (p + 1) * K)) : none;
  let acc1 = null;
  for (let p = 0; p < PAGES; p++) {
    keys[p] = pageKey(h.acc, p);
    if (p === 1) acc1 = h.acc.slice();
    if (p * K < m.length) h.add(digits(p));   // past the number's last digit the hash stays put: keys differ only by p
  }
  return { m, keys, digits, acc1 };
}
// Page (1-410) of the book at an address. floor and unit are safe integers or Bigs.
export function pageText(a, page) { return bookReader(a)(page); }
// A reader for one book at an address, or from a book number (search()'s `book`): the per-book work is done
// once, so turning pages is quick. Returns page (1-410) → text.
export function bookReader(a) {
  const plan = planBook(a);
  return page => render(writePage(plan.keys[page - 1], page - 1, plan.digits(page - 1)));
}

// The same from a scrambled number directly: for scripts/check-near.ts, which changes one of its digits.
export function readerOfScrambled(m) {
  const plan = planScrambled(trim(m));
  return page => render(writePage(plan.keys[page - 1], page - 1, plan.digits(page - 1)));
}

// For scanners (scan.js, scan-gpu.js), which read whole shelves: page i of a book is the stream seedState(keys[i],
// D_PG, i), with digits(i) added and absorbed. A nearby book's scrambled number is a few digits on page 1, so page 1
// uses the empty prefix's key and every other page the key of acc1, the hash of those digits.
export const STREAM = Object.freeze({
  SYMBOLS, D_PG, K, PAGES, ACC, QR_ROT: Object.freeze(QR_ROT), HASH_IV: Object.freeze(HASH_IV), HASH_WORD_ROUNDS, HASH_FINAL_ROUNDS,
  SEED_XOR, SEED_ROUNDS, ABSORB_MUL, ABSORB_ROUNDS, XO_MUL1, XO_ROT1, XO_MUL2, XO_SHIFT, XO_ROT2,
  PRIMES: Object.freeze(PRIMES), ROOTS: Object.freeze(ROOTS),
});
// Known answers for the page stream, computed once from this code (library 'sides-1') and frozen here: if any copy of
// the stream (this file, scan.js, scan-gpu.js's WGSL) changes, a book somewhere reads differently, and
// scripts/check-stream.ts (babel.js, scan.js, the WGSL's constants) or scripts/check-scan-gpu.ts (the GPU) says so.
// Words are uint32. A book's address has floor and unit as numbers or decimal strings (bigFromDecimal). Changing these
// is changing the library: bump LIBRARY with them.
export const STREAM_VECTORS = Object.freeze({
  keys: [   // pageKey(acc, page)
    { acc: [0, 0, 0, 0, 0], page: 0, key: [0xbda03459, 0xdc79b189, 0x27cfe72e, 0xe1df1f4a] },
    { acc: [1, 2, 3, 4, 5], page: 1, key: [0x839bde73, 0xe58d5f70, 0xd6eb8970, 0x39bd82e9] },
    { acc: [67108858, 40009711, 0, 9876413, 67108762], page: 409, key: [0x9af094e0, 0x07435a21, 0xa091acc5, 0xc869e0c6] },
  ],
  seeds: [   // seedState(key, D_PG, page)
    { key: [0x00000000, 0x00000000, 0x00000000, 0x00000000], page: 0, state: [0xedeab61f, 0xe1910bf9, 0xbbaf85c0, 0x9c0bd579] },
    { key: [0x12345678, 0x9abcdef0, 0x0fedcba9, 0x87654321], page: 409, state: [0x7bb86f02, 0x77280d99, 0x91010c4c, 0x999d68d1] },
  ],
  absorb: [   // absorb(state, v, j)
    { state: [0x00000001, 0x00000002, 0x00000003, 0x00000004], v: 1, j: 0, out: [0xa9eb0e7d, 0x0e42b1df, 0xf91cf06a, 0xeec1084a] },
    { state: [0xdeadbeef, 0x01234567, 0x89abcdef, 0xcafef00d], v: 28, j: 3199, out: [0xb5010491, 0x4d9dcef6, 0x309658fc, 0xaa44de05] },
  ],
  // books: the scrambled number m and acc1 (nearPlan), and the head (first 96) and tail (last 32) symbols of pages 1, 2 and 410
  books: [
    { address: { floor: 0, unit: 0, side: 0, shelf: 0, slot: 0 },
      m: [],
      acc1: [0, 0, 0, 0, 0],
      pages: [
        { page: 1, head: 'qvxqpwpveqseflzn,tj.p,aupm,qqmcukccdrlssvmnpnrr,tskohvevkvwhgb.ubqiziwqpdekaqelbemfly.mqp qwbaxz', tail: 'mjshupcqmspaoxddypsjfpzhjdraqtbe' },
        { page: 2, head: 'iqjwyebqbthmsdxrkb.g xxwrymx..zeydiwqwkodh.funmtsm.v,bams itjslspbdjhkmcvtcwizlhlpuv.wxim,,qc,lk', tail: 'uzhzwqldkpflna pbllb xfwvquirvtg' },
        { page: 410, head: 'jnjlhfdehoocohlozs hunojtkxlk.n jfmnnuw,mktiwoj x.kych l ..,oyozq,cczdpkcvh,kdlr ijisji.jlbr,yn,', tail: 'rsxlkucvptmiz krfqnyezbsimmln.ld' },
      ] },
    { address: { floor: -7, unit: -1234, side: 1, shelf: 5, slot: 31 },
      m: [25, 18, 10, 24, 6, 13],
      acc1: [61538125, 27588803, 26387767, 62475819, 50317291],
      pages: [
        { page: 1, head: 'mkg,njfwyqleccpcjj,ycnmz,ld wuyr,ahrjdujwcxjshupihy..bvyo,noueahskztcbjlsmzkx.jmmzup rurrzvaooxd', tail: 'qzawvcxfxs .r jegvr,nugcpqolkyeh' },
        { page: 2, head: 'jenvpbdi  o.lnrtenitkiwzk vfrpioonf,.vdkftfxxhiolqxdavhyoyuwrwvgq.bm.,fsgt,gznsnpmuboomrbrlqzdqr', tail: 'r.fhjoasalwiibtlxfx,xfuewrefx.wc' },
        { page: 410, head: 'ebolcxvrjy,su,wuh pmpftzwuvhfrh,pe,cuxj ptkhmuoeublawn.szksunlon,nga,toj,qankkf.jgaxhfedxt,dzkw ', tail: 'hpzsjztfnlpiqgsawz.a.fvwapxjnjfd' },
      ] },
    { address: { floor: Number.MAX_SAFE_INTEGER, unit: -Number.MAX_SAFE_INTEGER, side: 1, shelf: 3, slot: 17 },
      m: [11, 22, 22, 22, 3, 11, 7, 12, 25, 19, 23, 27, 7, 8, 12, 7, 5, 22, 16, 25, 28, 12, 14, 1, 1],
      acc1: [17360859, 35600265, 23028799, 11383873, 12777502],
      pages: [
        { page: 1, head: ',.nzccti.mfvlktjxnoldlqglceuptsfwjtglqtiv,,avritrn lbznefgiylwbynnvdbfaaptkb.jjlbhfpbbqcc vkvlca', tail: '.,qaiziaeemfzd .erpmyn.ysc hbztm' },
        { page: 2, head: 'nxm blfigsa ip,.rlpstmbksntsxj zypurcgqjzkiwjpjcpp,jyecq.tnbloxv swmxdkpowaqqi bdplqpvvtkmrfne,k', tail: 'vitghlvnktufagkcxjtdorcgmumuxfvs' },
        { page: 410, head: ' z.,sfukfhgzpsn gqrqabgdjtp,edoquwrw,vlpbykga,g.txwph.,fg,azmnnsoz.fq.lvf,gpmfigqhtsrfv,uq.okllq', tail: 'orxg.,pd.yyh,dvritysnxkzwiqouada' },
      ] },
    { address: { floor: '1000000000000000000000000000000000000000000000000000000000000', unit: '-12345678901234567890', side: 0, shelf: 2, slot: 9 },
      m: [26, 5, 5, 12, 3, 20, 8, 9, 19, 1, 4, 28, 26, 17, 6, 13, 3, 27, 8, 20, 28, 17, 24, 19, 12, 11, 13, 20, 25, 9, 2, 2, 2, 20, 21, 4, 1, 27, 25, 10, 15, 3, 9, 14, 27, 17, 12, 3, 7, 8, 26, 23, 11, 5, 18, 16, 10, 6, 13, 27, 27, 6, 24, 3, 7, 0, 12, 16, 2, 27, 0, 28, 1, 5, 23, 12, 0, 13, 8, 3, 7, 23, 19, 16, 4],
      acc1: [1658676, 42520125, 8638841, 36456876, 52544413],
      pages: [
        { page: 1, head: 'n szxyqcbseo a ocmx wrvnktrkbizdytn safpkbhqrvhw,.egdasrpoeadgdvi avvlrxhivm evr,zd.,nwbdsvfggfh', tail: 'sxkarslgk,pjnlgcbmrueo,yyobxhcpt' },
        { page: 2, head: 'vfk, lmi qjxu ymyzagvlh dikmkyvvk ftp.hnqppt,jznkdvcggbja vtptmfemiajvs .h.h.sakqcpzj,zxbg.rpz,o', tail: 'rpagjkm.vdqvnousptc.hzeqnleljk s' },
        { page: 410, head: 'f,lfdx.band, trne,snmzctsdr,zhvevilekxeipqgoqgjucqh wtow.vbstc. ,sptolb rlf kferpm.,gljon,ufnjqo', tail: 'qaacbzmyilenipdxszh,wugedifwfiff' },
      ] },
  ],
});
// The little a GPU needs per nearby book: the scrambled number (one page or less) and acc1. null past one page.
export function nearPlan(a) {
  const n = a instanceof Uint8Array ? trim(a) : bookNumber(a);
  if (!n) throw new RangeError('that shelf lies past the end of the library');
  const m = scramble(n); if (m.length > K) return null;
  const h = prefixHash(); h.add(m);
  return { m, acc1: h.acc.slice() };
}
export const emptyKey = () => pageKey(new Array(ACC).fill(0), 0);
export { pageKey };

// Where a whole book is shelved, from its 410 pages of text (newlines are ignored): reading, run backwards, page by
// page and symbol by symbol. search() is this with one stretch of text given and everything else left as it falls.
export function addressOfPages(pages) {
  if (pages.length !== PAGES) throw new RangeError(`a book has ${PAGES} pages`);
  return addressOfText(p => {
    const c = toDigits(pages[p]); if (c.length !== K) throw new RangeError(`a page has ${K} characters`);
    return c;
  });
}
function addressOfText(page) {   // page(p) → that page's K symbols
  const m = new Uint8Array(L), h = prefixHash();
  for (let p = 0; p < PAGES; p++) {
    const c = page(p), blk = readPage(pageKey(h.acc, p), p, j => c[j]); m.set(blk, p * K); h.add(blk);
  }
  return addressOf(scramble(trim(m), true));
}

// The book that says one thing and nothing else: the text, then a space, again and again from the top of page 1 to
// the end of page 410. With a person's name, it is that person's own book. Returns its address and the text as
// repeated (lowercase, letters, spaces, commas and periods only), or null when nothing of the text is left.
export function repeatedBook(text) {
  const word = queryText(String(text).normalize('NFD').replace(/[\u0300-\u036f'\u2019]/g, '')).replace(/[^a-z ,.]+/g, ' ').replace(/ +/g, ' ').trim();   // é → e, o'brien → obrien
  if (!word) return null;
  const unit = toDigits(word + ' '), n = unit.length;
  return { address: addressOfText(p => { const c = new Uint8Array(K); for (let j = 0; j < K; j++) c[j] = unit[(p * K + j) % n]; return c; }), text: word };
}

// A query as the library spells it: lowercase, and a line break is only where a page's line ends, not a character,
// so text copied from a page (lines of 80, joined by newlines) is searched as it stands on the page. A tab is a space.
export const queryText = text => String(text).toLowerCase().replace(/\r?\n|\r/g, '').replace(/\t/g, ' ');

// Where the given text is written. It goes on `page` (1-410, default 1) starting at character `at` (0-based,
// reading order, default 0): the top of page 1 is the nearest place there is, since every character before the
// text costs a digit of the book number. The rest of that page falls as it would naturally (so the text runs
// straight into the symbols after it: to stand as its own words, search it with spaces around it), or `blank`
// leaves it empty. Returns the address, the book number, the query as placed, the placement and that page's text.
export function search(text, opts = {}) {
  const want = queryText(text);
  if (!want.length || want.length > K) throw new RangeError(`text must be 1-${K} characters (a line break does not count)`);
  const t = toDigits(want), page = opts.page ?? 1, at = opts.at ?? 0;
  if (!Number.isInteger(page) || page < 1 || page > PAGES) throw new RangeError(`page must be a whole number from 1 to ${PAGES}`);
  if (!Number.isInteger(at) || at < 0 || at + t.length > K) throw new RangeError('text does not fit there');
  // every page before this one falls as the stream gives it (zero digits), so this page's key is the empty prefix's
  const h = prefixHash(); for (let p = 0; p < page - 1; p++) h.add(null);
  const key = pageKey(h.acc, page - 1);
  const blk = readPage(key, page - 1, j => j >= at && j < at + t.length ? t[j - at] : opts.blank ? 26 : -1);
  const m = new Uint8Array(page * K); m.set(blk, (page - 1) * K);
  const n = scramble(trim(m), true);
  return { address: addressOf(n), book: n, query: want, page, line: Math.floor(at / COLS) + 1, col: at % COLS + 1, length: t.length,
    text: render(writePage(key, page - 1, blk)) };
}

// A Big in decimal, and back: for call slips, which write an address out in full (up to about 959,000 digits each
// for floor and unit, which takes a second or two).
export function bigToDecimal(b) {
  const d = b.d, pow = new Map(), p29 = k => { if (!pow.has(k)) pow.set(k, 29n ** BigInt(k)); return pow.get(k); };
  const part = (lo, hi) => {   // digits [lo, hi) as a BigInt, split at powers of two so the powers of 29 repeat
    if (hi - lo <= 64) { let v = 0n; for (let i = hi - 1; i >= lo; i--) v = v * 29n + BigInt(d[i]); return v; }
    const k = 2 ** Math.floor(Math.log2(hi - lo - 1));
    return part(lo, lo + k) + part(lo + k, hi) * p29(k);
  };
  const v = d.length ? part(0, d.length) : 0n;
  return (b.neg && v ? '-' : '') + v.toString();
}
export function bigFromDecimal(s) {
  const m = /^\s*(-?)(\d+)\s*$/.exec(String(s));
  if (!m) throw new RangeError('not a whole number');
  const t = BigInt(m[2]).toString(29), d = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) d[t.length - 1 - i] = parseInt(t[i], 29);
  return { neg: m[1] === '-' && t !== '0', d: trim(d) };
}
// log10 of a Big's size (0 for 0)
export function log10Big(b) {
  const d = b.d, top = Math.min(10, d.length);
  if (!top) return -Infinity;
  let lead = 0; for (let i = d.length - 1; i >= d.length - top; i--) lead = lead * 29 + d[i];
  return Math.log10(lead) + (d.length - top) * Math.log10(29);
}
// How long walking there from the spawn would take, as log10 of years: along the gallery at 1.5 m/s, and up or down
// the stairs, about 5 m of walking a floor. The larger distance is the whole story at these sizes.
export function walkYearsLog10(address) {
  const f = typeof address.floor === 'number' ? bigFromNumber(address.floor) : address.floor;
  const u = typeof address.unit === 'number' ? bigFromNumber(address.unit) : address.unit;
  return Math.max(log10Big(u), log10Big(f) + Math.log10(5)) - Math.log10(1.5 * 365.25 * 86400);
}
// That walk in words: minutes, days or years when it is a human span, else a power of ten.
export function describeWalk(address) {
  const y = walkYearsLog10(address);
  if (y > 6) return `about 10^${Math.round(y).toLocaleString('en-US')} years`;
  const sec = 10 ** y * 365.25 * 86400, r = (v, u) => `about ${Math.max(1, Math.round(v)).toLocaleString('en-US')} ${u}${Math.round(v) === 1 ? '' : 's'}`;
  return sec < 90 ? r(sec, 'second') : sec < 5400 ? r(sec / 60, 'minute') : sec < 172800 ? r(sec / 3600, 'hour') : sec < 63e6 ? r(sec / 86400, 'day') : r(sec / 31557600, 'year');
}
// A Big in words: exact when small, else its size, leading digits and final digits in decimal.
export function describeBig(b) {
  const v = bigToNumber(b);
  if (v !== null) return String(v);
  const d = b.d, top = Math.min(10, d.length);
  let lead = 0; for (let i = d.length - 1; i >= d.length - top; i--) lead = lead * 29 + d[i];
  const log = Math.log10(lead) + (d.length - top) * Math.log10(29), exp = Math.floor(log);
  let hi = 0, lo = 0;   // the last ten decimal digits, as two int32 halves of five
  let i = d.length - 1;
  for (; i >= 1; i -= 2) {
    const l = lo * 841 + d[i] * 29 + d[i - 1], c = (l / 100000) | 0; lo = l - c * 100000;
    const h = hi * 841 + c; hi = h - ((h / 100000) | 0) * 100000;
  }
  for (; i >= 0; i--) {
    const l = lo * 29 + d[i], c = (l / 100000) | 0; lo = l - c * 100000;
    const h = hi * 29 + c; hi = h - ((h / 100000) | 0) * 100000;
  }
  const tail = String(hi).padStart(5, '0') + String(lo).padStart(5, '0');
  const mant = Math.pow(10, log - exp).toFixed(7);
  return `${b.neg ? '−' : ''}${mant}×10^${exp} (${(exp + 1).toLocaleString('en-US')} digits, ending …${tail})`;
}
