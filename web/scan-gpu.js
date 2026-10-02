// The shelf scanner (scan.js) on the GPU: one thread per page, so a unit's 78,720 pages run at once.
// The CPU works out each book's scrambled number and acc1 (babel.js nearPlan); each GPU thread hashes its own page
// key, runs its page's stream (adding and absorbing the number's digits on page 1) through the word finder, and
// reports each find's place; the CPU then reads the words back from that spot.
// Same rules as scan.js, and scripts/check-scan-gpu.ts holds the two to identical output.
//
// The page stream here is babel.js's, in WGSL: every constant in it is interpolated from babel.js's STREAM (none is
// written out), scripts/check-stream.ts checks that statically, and scripts/check-scan-gpu.ts runs the probe entry
// point against babel.js's known answers (STREAM_VECTORS).

import { ALPHABET, PAGES, SHELVES, SLOTS, STREAM, nearPlan } from './babel.js';
import { nearPageSymbols } from './scan.js';

const PER_UNIT = SHELVES * SLOTS, BOOK_WORDS = 16, DIGITS_AT = 8, FIND_WORDS = 4, NEAR_DIGITS = 32;
// isWord's hash of a word into the GPU's word table (buildTable below): the table's own, not the page stream's
export const TABLE_HASH = Object.freeze([0x9E3779B1, 0x85EBCA77]);

// The page stream in WGSL, from the stream's constants (C: babel.js's STREAM unless a check passes another): `fns`,
// babel.js's qr, seedState, pageKey (with hash) and step's output digit, and `step`, the statements that advance a
// page's stream by one symbol on the locals a, b, c, d, j, page and low (page 1's digits) into g, adding and absorbing
// page 1's digits (babel.js step and absorb). The step is pasted into each entry point rather than called, so the
// state stays in four scalars: a function on a vec4 pointer ran the scanner at half speed.
export function streamWgsl(C = STREAM) {
  if (C.ACC > DIGITS_AT || DIGITS_AT + NEAR_DIGITS / 4 > BOOK_WORDS) throw new RangeError('a book\'s words do not fit');
  const u = x => `${x >>> 0}u`, hex = x => `0x${(x >>> 0).toString(16)}u`;
  const rounds = (n, s) => n <= 4 ? Array(n).fill(`qr(${s});`).join(' ') : `for (var r = 0u; r < ${u(n)}; r++) { qr(${s}); }`;
  const fns = /* wgsl */`
fn rotl(x: u32, r: u32) -> u32 { return (x << r) | (x >> (32u - r)); }
fn qr(s: ptr<function, vec4<u32>>) {
  var a = (*s).x; var b = (*s).y; var c = (*s).z; var d = (*s).w;
  a = a + b; d = rotl(d ^ a, ${u(C.QR_ROT[0])}); c = c + d; b = rotl(b ^ c, ${u(C.QR_ROT[1])});
  a = a + b; d = rotl(d ^ a, ${u(C.QR_ROT[2])}); c = c + d; b = rotl(b ^ c, ${u(C.QR_ROT[3])});
  *s = vec4<u32>(a, b, c, d);
}
fn seed(k0: u32, k1: u32, k2: u32, k3: u32) -> vec4<u32> {
  var s = vec4<u32>(k0, k1, k2, k3 ^ ${hex(C.SEED_XOR)});
  ${rounds(C.SEED_ROUNDS, '&s')}
  if ((s.x | s.y | s.z | s.w) == 0u) { s.x = 1u; }
  return s;
}
// floor(x × SYMBOLS / 2^32) in 32 bits
fn digit(x: u32) -> u32 { return ((x >> 16u) * ${u(C.SYMBOLS)} + (((x & 65535u) * ${u(C.SYMBOLS)}) >> 16u)) >> 16u; }
// page p's key: babel.js hash([acc0..acc${C.ACC - 1}, p], D_PG), acc = 0 on page 1 and acc1 after it
fn pageKey(o: u32, page: u32) -> vec4<u32> {
  var h = vec4<u32>(${hex(C.HASH_IV[0])}, ${hex(C.HASH_IV[1])} ^ ${hex(C.D_PG)}, ${hex(C.HASH_IV[2])}, ${hex(C.HASH_IV[3])} ^ ${u(C.ACC + 1)});
  for (var i = 0u; i < ${u(C.ACC)}; i++) {
    var w = 0u; if (page > 0u) { w = books[o + i]; }
    h.x = h.x ^ w; ${rounds(C.HASH_WORD_ROUNDS, '&h')}
  }
  h.x = h.x ^ page; ${rounds(C.HASH_WORD_ROUNDS, '&h')}
  ${rounds(C.HASH_FINAL_ROUNDS, '&h')}
  return h;
}
// the state at the top of page p: babel.js seedState(pageKey, D_PG, p)
fn pageStart(o: u32, page: u32) -> vec4<u32> {
  let key = pageKey(o, page);
  return seed(key.x ^ ${hex(C.D_PG)}, key.y ^ page, key.z, key.w);
}
`;
  const step = /* wgsl */`
      let x = rotl(b * ${u(C.XO_MUL1)}, ${u(C.XO_ROT1)}) * ${u(C.XO_MUL2)}; let t = b << ${u(C.XO_SHIFT)};
      c = c ^ a; d = d ^ b; b = b ^ c; a = a ^ d; c = c ^ t; d = rotl(d, ${u(C.XO_ROT2)});
      g = digit(x);
      if (page == 0u && j < ${u(NEAR_DIGITS)}) {
        let v = (low[j >> 2u] >> ((j & 3u) * 8u)) & 255u;
        if (v > 0u) {   // a digit of the number: added, then absorbed (babel.js absorb)
          g = g + v; if (g >= ${u(C.SYMBOLS)}) { g = g - ${u(C.SYMBOLS)}; }
          var st = vec4<u32>(a ^ ((v * ${hex(C.ABSORB_MUL)}) ^ j), b, c, d); ${rounds(C.ABSORB_ROUNDS, '&st')}
          a = st.x; b = st.y; c = st.z; d = st.w;
        }
      }`;
  return { fns, step };
}

// The shader: the stream, the word finder (main), and probe.
export function wgsl(C = STREAM) {
  const u = x => `${x >>> 0}u`, hex = x => `0x${(x >>> 0).toString(16)}u`, { fns, step } = streamWgsl(C);
  // the top of page p's stream in a, b, c, d, and page 1's digits in low: read once here, not from storage inside the
  // page's loop (that read, under a page test, came out wrong past digit 32 on Metal with an AMD GPU)
  const start = `
  let s = pageStart(o, page);
  var a = s.x; var b = s.y; var c = s.z; var d = s.w;
  var low: array<u32, ${NEAR_DIGITS / 4}>;
  if (page == 0u) { for (var i = 0u; i < ${u(NEAR_DIGITS / 4)}; i++) { low[i] = books[o + ${u(DIGITS_AT)} + i]; } }`;
  return /* wgsl */`
struct Params { books: u32, minLen: u32, maxFinds: u32, mask: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> books: array<u32>;       // per book: acc1[${C.ACC}], spare to ${DIGITS_AT}, m digits (${NEAR_DIGITS} bytes)
@group(0) @binding(2) var<storage, read> table: array<u32>;      // open addressing: (lo, hi) pairs, 0 = empty
@group(0) @binding(3) var<storage, read_write> count: atomic<u32>;
@group(0) @binding(4) var<storage, read_write> finds: array<u32>; // per find: book, page, at, len | words << 16

// ---- the page stream: babel.js's, from STREAM
${fns}
// ---- the word finder
fn isWord(lo: u32, hi: u32) -> bool {
  var h = (lo * ${hex(TABLE_HASH[0])}) ^ (hi * ${hex(TABLE_HASH[1])}); h = h ^ (h >> 15u);
  var i = h & P.mask;
  loop {
    let klo = table[2u * i]; let khi = table[2u * i + 1u];
    if (khi == 0u) { return false; }
    if (klo == lo && khi == hi) { return true; }
    i = (i + 1u) & P.mask;
  }
}
fn emit(book: u32, page: u32, at: u32, len: u32, words: u32) {
  let n = atomicAdd(&count, 1u);
  if (n < P.maxFinds) { finds[4u * n] = book; finds[4u * n + 1u] = page; finds[4u * n + 2u] = at; finds[4u * n + 3u] = len | (words << 16u); }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gid.x + gid.y * nwg.x * 64u;
  let book = id / ${u(C.PAGES)}; let page = id % ${u(C.PAGES)};
  if (book >= P.books) { return; }
  let o = book * ${u(BOOK_WORDS)};${start}

  var tl = 0u; var lo = 0u; var hi = 0u; var ts = 0u;
  var rw = 0u; var rs = 0u; var re = 0u; var pend = 0u;
  for (var j = 0u; j <= ${u(C.K)}; j++) {
    var g = 29u;                                   // j == K: the page's edge, a separator that ends everything
    if (j < ${u(C.K)}) {${step}
    }
    if (g < 26u) {
      if (tl == 0u) {
        ts = j; lo = 0u; hi = 0u;
        if (pend == 2u) { if (rw > 0u && re - rs >= P.minLen) { emit(book, page, rs, re - rs, rw); } rw = 0u; pend = 0u; }
      }
      if (tl < 6u) { lo = lo | ((g + 1u) << (5u * tl)); } else if (tl < 10u) { hi = hi | ((g + 1u) << (5u * (tl - 6u))); }
      tl = tl + 1u;
    } else if (tl > 0u) {
      if (tl <= 10u && isWord(lo, hi | (tl << 20u))) {
        if (rw == 0u) { rs = ts; }
        rw = rw + 1u; re = j;
        if (g == 26u) { pend = 1u; }
        else if (g == 27u) { pend = 2u; }
        else {
          if (g == 28u) { re = j + 1u; }
          if (re - rs >= P.minLen) { emit(book, page, rs, re - rs, rw); }
          rw = 0u; pend = 0u;
        }
      } else {
        if (rw > 0u && re - rs >= P.minLen) { emit(book, page, rs, re - rs, rw); }
        rw = 0u; pend = 0u;
      }
      tl = 0u;
    } else if (pend == 2u && g == 26u) { pend = 3u; }
    else if (rw > 0u) {
      if (re - rs >= P.minLen) { emit(book, page, rs, re - rs, rw); }
      rw = 0u; pend = 0u;
    }
  }
}

// For scripts/check-scan-gpu.ts: each page's first P.minLen and last P.mask symbols, from the same stream code as
// main, into finds (P.minLen + P.mask words a page, in book and page order).
@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gid.x + gid.y * nwg.x * 64u;
  let book = id / ${u(C.PAGES)}; let page = id % ${u(C.PAGES)};
  if (book >= P.books) { return; }
  let o = book * ${u(BOOK_WORDS)};${start}
  let head = P.minLen; let tail = P.mask; let at = id * (head + tail);
  for (var j = 0u; j < ${u(C.K)}; j++) {
    var g = 0u;${step}
    if (j < head) { finds[at + j] = g; } else if (j >= ${u(C.K)} - tail) { finds[at + head + j - (${u(C.K)} - tail)] = g; }
  }
}`;
}
export const WGSL = wgsl();

// the word list as the GPU's hash table: letters 1-26 five bits each, first six in lo, rest in hi with the length
function buildTable(list) {
  let size = 1; while (size < list.length * 2) size <<= 1;
  const t = new Uint32Array(size * 2), mask = size - 1;
  for (const w of list) {
    let lo = 0, hi = w.length << 20;
    for (let i = 0; i < w.length; i++) { const v = w.charCodeAt(i) - 96; if (i < 6) lo |= v << (5 * i); else hi |= v << (5 * (i - 6)); }
    lo >>>= 0; hi >>>= 0;
    let h = (Math.imul(lo, TABLE_HASH[0]) ^ Math.imul(hi, TABLE_HASH[1])) >>> 0; h = (h ^ (h >>> 15)) >>> 0;
    let i = h & mask; while (t[2 * i + 1]) { if (t[2 * i] === lo && t[2 * i + 1] === hi) break; i = (i + 1) & mask; }
    t[2 * i] = lo; t[2 * i + 1] = hi;
  }
  return { t, mask };
}

// the text of a find, read back from its page's stream (scan.js, which runs it fastest)
function phraseAt(plan, page, at, len) {
  const sym = nearPageSymbols(plan, page, at + len);
  let out = ''; for (let j = at; j < at + len; j++) out += ALPHABET[sym[j]];
  return out;
}

export async function createGpuScanner(words, { maxUnits = 8, maxFinds = 1 << 17 } = {}) {
  if (!globalThis.navigator?.gpu) throw new Error('no WebGPU here');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const { t, mask } = buildTable(words.list);
  const U = GPUBufferUsage;
  const tableBuf = device.createBuffer({ size: t.byteLength, usage: U.STORAGE | U.COPY_DST }); device.queue.writeBuffer(tableBuf, 0, t);
  const booksBuf = device.createBuffer({ size: maxUnits * PER_UNIT * BOOK_WORDS * 4, usage: U.STORAGE | U.COPY_DST });
  const paramBuf = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
  const countBuf = device.createBuffer({ size: 4, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
  const findBuf = device.createBuffer({ size: maxFinds * FIND_WORDS * 4, usage: U.STORAGE | U.COPY_SRC });
  const readCount = device.createBuffer({ size: 4, usage: U.MAP_READ | U.COPY_DST });
  const readFinds = device.createBuffer({ size: maxFinds * FIND_WORDS * 4, usage: U.MAP_READ | U.COPY_DST });
  const module = device.createShaderModule({ code: WGSL });
  const info = await module.getCompilationInfo?.();
  const errs = info?.messages?.filter(m => m.type === 'error') ?? [];
  if (errs.length) throw new Error('WGSL: ' + errs.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
  const S = GPUShaderStage.COMPUTE, layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: S, buffer: { type: 'uniform' } }, { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: S, buffer: { type: 'read-only-storage' } }, { binding: 3, visibility: S, buffer: { type: 'storage' } },
    { binding: 4, visibility: S, buffer: { type: 'storage' } }] });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pagesPipe = await device.createComputePipelineAsync({ layout: pl, compute: { module, entryPoint: 'main' } });
  let probePipe = null;
  // each book's plan (nearPlan: { m, acc1 }) packed as the shader reads it
  function packBooks(ps) {
    const data = new Uint32Array(ps.length * BOOK_WORDS);
    ps.forEach((p, i) => {
      if (!p || p.m.length > NEAR_DIGITS) throw new RangeError('for nearby shelves only');
      const m = new Uint8Array(NEAR_DIGITS); m.set(p.m);
      data.set(p.acc1, i * BOOK_WORDS); data.set(new Uint32Array(m.buffer), i * BOOK_WORDS + DIGITS_AT);
    });
    return data;
  }
  const bind = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: { buffer: paramBuf } }, { binding: 1, resource: { buffer: booksBuf } }, { binding: 2, resource: { buffer: tableBuf } },
    { binding: 3, resource: { buffer: countBuf } }, { binding: 4, resource: { buffer: findBuf } }] });

  // units: [{floor, unit, side?}], at most maxUnits. Returns finds like scan.js's scanUnit, best first: all of them, or
  // the best `keep` per unit, the only ones whose text is then read back (it costs a stream run each).
  async function scanUnits(units, min = 7, keep = Infinity) {
    if (units.length > maxUnits) throw new RangeError(`at most ${maxUnits} units per call`);
    const plans = [];
    for (const { floor, unit, side = 0 } of units) for (let s = 0; s < PER_UNIT; s++) {
      const a = { floor, unit, side, shelf: Math.floor(s / SLOTS), slot: s % SLOTS };
      plans.push({ a, p: nearPlan(a) });
    }
    const nb = plans.length;
    device.queue.writeBuffer(booksBuf, 0, packBooks(plans.map(x => x.p)));
    device.queue.writeBuffer(paramBuf, 0, new Uint32Array([nb, min, maxFinds, mask]));
    device.queue.writeBuffer(countBuf, 0, new Uint32Array([0]));
    const groups = Math.ceil(nb * PAGES / 64), gx = Math.min(groups, 65535), gy = Math.ceil(groups / gx);
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setBindGroup(0, bind);
    pass.setPipeline(pagesPipe); pass.dispatchWorkgroups(gx, gy); pass.end();
    enc.copyBufferToBuffer(countBuf, 0, readCount, 0, 4);
    enc.copyBufferToBuffer(findBuf, 0, readFinds, 0, maxFinds * FIND_WORDS * 4);
    device.queue.submit([enc.finish()]);
    await readCount.mapAsync(GPUMapMode.READ); const n = Math.min(new Uint32Array(readCount.getMappedRange())[0], maxFinds); readCount.unmap();
    await readFinds.mapAsync(GPUMapMode.READ, 0, Math.max(16, n * 16)); const f = new Uint32Array(readFinds.getMappedRange(0, Math.max(16, n * 16))).slice(0, n * 4); readFinds.unmap();
    const raw = [];
    for (let i = 0; i < n; i++) raw.push({ b: f[4 * i], page: f[4 * i + 1] + 1, at: f[4 * i + 2], len: f[4 * i + 3] & 0xffff, words: f[4 * i + 3] >>> 16 });
    raw.sort((x, y) => y.len - x.len || y.words - x.words);
    const per = new Map(), out = [];
    for (const r of raw) {
      const u = Math.floor(r.b / PER_UNIT), c = per.get(u) || 0;
      if (c >= keep) continue;
      per.set(u, c + 1);
      const { a, p } = plans[r.b];
      out.push({ ...a, page: r.page, at: r.at, len: r.len, words: r.words, text: phraseAt(p, r.page, r.at, r.len) });
    }
    return out;
  }
  // For scripts/check-scan-gpu.ts: the first `head` and last `tail` symbols (0-28) of every page of these books
  // (nearPlan's { m, acc1 }), from the shader's own stream code. Returns [book][page 0-409] → Uint32Array(head + tail).
  async function probe(ps, head, tail) {
    const per = head + tail, size = ps.length * PAGES * per * 4;
    if (ps.length > maxUnits * PER_UNIT || size > maxFinds * FIND_WORDS * 4) throw new RangeError('too many books to probe');
    probePipe ??= await device.createComputePipelineAsync({ layout: pl, compute: { module, entryPoint: 'probe' } });
    device.queue.writeBuffer(booksBuf, 0, packBooks(ps));
    device.queue.writeBuffer(paramBuf, 0, new Uint32Array([ps.length, head, maxFinds, tail]));
    const groups = Math.ceil(ps.length * PAGES / 64), gx = Math.min(groups, 65535), gy = Math.ceil(groups / gx);
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setBindGroup(0, bind); pass.setPipeline(probePipe); pass.dispatchWorkgroups(gx, gy); pass.end();
    enc.copyBufferToBuffer(findBuf, 0, readFinds, 0, size);
    device.queue.submit([enc.finish()]);
    await readFinds.mapAsync(GPUMapMode.READ, 0, size); const f = new Uint32Array(readFinds.getMappedRange(0, size)).slice(); readFinds.unmap();
    return ps.map((_, b) => Array.from({ length: PAGES }, (_, p) => f.subarray((b * PAGES + p) * per, (b * PAGES + p + 1) * per)));
  }
  return { scanUnits, probe, device, destroy: () => device.destroy() };
}
