// Checks the page stream, which is written three times: web/babel.js (the library), web/scan.js (inline, for speed)
// and the WGSL in web/scan-gpu.js. Each must reproduce babel.js's frozen known answers (STREAM_VECTORS), and the WGSL
// must take every constant from babel.js's STREAM, writing none out. No server, a second or two.
// The GPU itself runs the same answers in scripts/check-scan-gpu.ts. Run: node scripts/check-stream.ts
import { readFileSync } from 'node:fs';
import * as B from '../web/babel.js';
import { pageSymbolsOf, nearPageSymbols } from '../web/scan.js';
import { WGSL, wgsl, streamWgsl, TABLE_HASH } from '../web/scan-gpu.js';

let failed = 0;
const check = (ok: unknown, what: string) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) failed++; };
const V = B.STREAM_VECTORS, S = B.STREAM as Record<string, any>;
const u32 = (a: ArrayLike<number>) => Array.from(a, x => x >>> 0).join(',');
const big = (v: number | string) => typeof v === 'string' ? B.bigFromDecimal(v) : v;
const address = (a: any) => ({ ...a, floor: big(a.floor), unit: big(a.unit) });
const text = (sym: ArrayLike<number>) => Array.from(sym, g => B.ALPHABET[g]).join('');
const HEAD = V.books[0].pages[0].head.length, TAIL = V.books[0].pages[0].tail.length;
const ends = (t: string) => ({ head: t.slice(0, HEAD), tail: t.slice(-TAIL) });
const same = (got: { head: string, tail: string }, want: { head: string, tail: string }) => got.head === want.head && got.tail === want.tail;

// ---- babel.js
check(B.LIBRARY === 'sides-1', `the library is still ${B.LIBRARY} (the known answers are its)`);
check(V.keys.every((v: any) => u32(B.pageKey(v.acc, v.page)) === u32(v.key)), `babel.js pageKey: ${V.keys.length} known answers`);
check(V.seeds.every((v: any) => u32(B.seedState(v.key, S.D_PG, v.page)) === u32(v.state)), `babel.js seedState: ${V.seeds.length} known answers`);
check(V.absorb.every((v: any) => { const s = v.state.map((x: number) => x | 0); B.absorb(s, v.v, v.j); return u32(s) === u32(v.out); }),
  `babel.js absorb: ${V.absorb.length} known answers`);
let bad: string[] = [];
for (const b of V.books) {
  const a = address(b.address), plan = B.nearPlan(a)!, read = B.bookReader(a);
  if (!plan || plan.m.join(',') !== b.m.join(',') || plan.acc1.join(',') !== b.acc1.join(',')) bad.push(`plan ${JSON.stringify(b.address)}`);
  for (const p of b.pages) if (!same(ends(read(p.page).replace(/\n/g, '')), p)) bad.push(`page ${p.page} of ${JSON.stringify(b.address)}`);
}
check(!bad.length, `babel.js books: ${V.books.length} books' scrambled numbers, acc1 and pages 1, 2 and 410 ${bad.join('; ')}`);

// ---- scan.js: scanPage's inline stream (through the ring it leaves a page in) and nearPageSymbols (finds' text)
bad = [];
for (const b of V.books) for (const p of b.pages) {
  const a = address(b.address);
  if (!same(ends(text(pageSymbolsOf(a, p.page))), p)) bad.push(`scanPage, page ${p.page} of ${JSON.stringify(b.address)}`);
  if (!same(ends(text(nearPageSymbols({ m: Uint8Array.from(b.m), acc1: b.acc1 }, p.page))), p)) bad.push(`nearPageSymbols, page ${p.page} of ${JSON.stringify(b.address)}`);
}
check(!bad.length, `scan.js reproduces the known pages, by scanPage and by nearPageSymbols ${bad.join('; ')}`);
{   // the other road through scanPage: a book whose number runs past page 1 has every page key worked out (planBook)
  const a = { floor: B.bigFromDecimal('9'.repeat(5000)), unit: 7, shelf: 1, slot: 2 };
  const ok = B.nearPlan(a) === null && [1, 2, 205, 410].every(p => text(pageSymbolsOf(a, p)) === B.pageText(a, p).replace(/\n/g, ''));
  check(ok, 'scan.js reads a far book (its number runs past page 1) as babel.js does');
}

// ---- scan-gpu.js: the WGSL takes every stream constant from babel.js's STREAM
const GPU_KEYS = Object.keys(S).filter(k => k !== 'PRIMES' && k !== 'ROOTS');   // acc1 is worked out on the CPU
const values = (v: any): number[] => Array.isArray(v) ? v : [v];
const lit = (x: number) => [`${x >>> 0}u`, `0x${(x >>> 0).toString(16)}u`];
check(WGSL === wgsl(B.STREAM), 'the shader is built from babel.js\'s STREAM');
const missing = GPU_KEYS.flatMap(k => values(S[k]).filter(x => !lit(x).some(l => WGSL.includes(l))).map(x => `${k}=${x}`));
check(!missing.length, `the WGSL contains every stream constant: ${GPU_KEYS.join(', ')} ${missing.join(' ')}`);
// each constant changed alone changes the shader: interpolated, not also written out somewhere
const unwired = GPU_KEYS.filter(k => {
  const C = { ...S, [k]: Array.isArray(S[k]) ? S[k].map((x: number) => x + 1) : k === 'ACC' ? S[k] - 1 : S[k] + 1 };
  return wgsl(C) === WGSL;
});
check(!unwired.length, `each stream constant, changed alone, changes the shader ${unwired.join(' ')}`);
// every hex literal in the shader is a stream constant (or the word table's hash, which is the GPU's own)
const known = new Set([...GPU_KEYS.flatMap(k => values(S[k])), ...TABLE_HASH].map(x => x >>> 0));
const stray = [...WGSL.matchAll(/0x[0-9a-f]+/gi)].map(m => m[0]).filter(h => !known.has(parseInt(h, 16)));
check(!stray.length, `no hex literal in the WGSL that isn't from babel.js ${stray.join(' ')}`);
{   // with every stream constant poisoned to a sentinel, the stream's WGSL has no number left but sentinels and its
    // own structure (bit fields of a u32, page 1's packed digits): a constant written out would show up here
  let n = 1000003; const sentinel = new Set<number>(), C: Record<string, any> = { ...S, ACC: 4 };
  const next = () => { sentinel.add(n); return n++ * 7; };
  for (const k of GPU_KEYS) if (k !== 'ACC') C[k] = Array.isArray(S[k]) ? S[k].map(next) : next();
  const { fns, step } = streamWgsl(C), allowed = new Set([...[...sentinel].map(x => x * 7), C.ACC, C.ACC + 1, 0, 1, 2, 3, 8, 16, 32, 255, 65535]);
  const left = [...(fns + step).matchAll(/\b(0x[0-9a-f]+|\d+)u\b/gi)].map(m => Number(m[1])).filter(x => !allowed.has(x));
  check(!left.length, `the stream's WGSL writes out no constant of its own ${left.join(' ')}`);
  const step0 = streamWgsl().step;
  check(WGSL.split(step0).length === 3 && WGSL.includes(streamWgsl().fns), 'the scanner and the probe run the same stream WGSL');
}
// the JavaScript copies write out none of babel.js's stream constants either (TABLE_HASH[0] is ABSORB_MUL's value by chance)
const streamHex = new Set(GPU_KEYS.flatMap(k => values(S[k])).filter(x => x >= 65536).map(x => x >>> 0));
const sources = ['scan.js', 'scan-gpu.js'].map(f => [f, readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').replace(/^export const TABLE_HASH.*$/m, '')]);
const written = sources.flatMap(([f, src]) => [...src.matchAll(/\b(0x[0-9a-f]+|\d{3,})\b/gi)].filter(m => streamHex.has(Number(m[1]))).map(m => `${f}: ${m[0]}`));
check(!written.length, `scan.js and scan-gpu.js write out none of babel.js's stream constants ${written.join(' ')}`);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
