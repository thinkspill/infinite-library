// Finds English on the shelves around the player, nearest shelves first: runs scan-worker.js on the GPU if the
// browser has WebGPU (about a hundred metres of shelf a second), else on a few CPU cores (a fraction of a metre
// each), and keeps what it found per shelf unit. The page asks it for the best finds near where you stand.
//
// createFinder is the planner: which units to read next (nearest to where you will be, reading ahead as you walk),
// how far and in what batches (tuned to the measured speed), what to keep, and what to drop after a teleport or a
// fall across the shaft. What it reads with is injected: `scanners` makes the workers (browserScanners below: real
// scan-worker.js workers and the page's own GPU; check-finder.ts passes fakes), `loadWords` fetches the word list,
// `now` is the clock, `phone` and `cores` size the CPU pool. Every worker speaks scan-worker.js's messages:
// in { t: 'init', words, gpu, batch } → out { t: 'ready', gpu }; in { t: 'scan', epoch, origin, units, min } →
// out { t: 'done', epoch, units: [{ key, finds }], ms }.
import { rarity, loadWords as parseWords, byUnit } from './scan.js';

export const MIN = 7;             // shortest find, in characters
export const MAX_UNITS = 40000;   // scanned units kept; the farthest go first
export const LEAD_S = 8;          // read ahead to where you will be this many seconds from now
export const FAR_REACH = 4;       // after a teleport: metres read either way of you

const KEEP = 8;            // finds kept per unit, best first (as scan-worker.js keeps them)

// Phones and tablets read with one CPU worker, not one per spare core: without WebGPU, more would mean heat and battery.
export const isPhone = () => !!globalThis.matchMedia?.('(pointer: coarse)').matches;
export const cpuWorkerCount = (phone, cores = 4) => phone ? 1 : Math.max(1, Math.min(6, (cores || 4) - 2));

// The GPU scanner on the page itself, for browsers whose pages have WebGPU but whose workers don't. It answers the
// same messages as scan-worker.js; its CPU share (planning each book, reading back kept finds) is a few ms a batch.
function pageWorker(gpu) {
  const w = new EventTarget();
  w.postMessage = async m => {
    if (m.t !== 'scan') return;
    const t0 = performance.now(), all = await gpu.scanUnits(m.units, m.min, KEEP);
    w.dispatchEvent(new MessageEvent('message', { data: { t: 'done', epoch: m.epoch, units: byUnit(m.units, all, KEEP), ms: performance.now() - t0 } }));
  };
  return w;
}

// The browser's scanners: `hasGpu` (the page has WebGPU), `spawn()` a scan-worker.js (not yet initialised), and
// `page(words)` the GPU on the page, throwing (message naming the adapter when there is none) if it can't.
export function browserScanners() {
  return {
    hasGpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    spawn: () => new Worker(new URL('scan-worker.js', import.meta.url), { type: 'module' }),
    async page(words) {
      const { createGpuScanner } = await import('./scan-gpu.js');
      return pageWorker(await createGpuScanner(parseWords(words), { maxUnits: 4 }));
    },
  };
}
export const fetchWords = async () => (await fetch(new URL('words.txt', import.meta.url))).text();

// force: 'cpu' (no GPU) or 'page' (the GPU on the page, not in a worker), for testing
export function createFinder({
  onChange = () => {}, onFinds = () => {}, force = null,
  scanners = browserScanners(), loadWords = fetchWords, now = () => performance.now(),
  phone = isPhone(), cores = globalThis.navigator?.hardwareConcurrency || 4, maxUnits = MAX_UNITS,
} = {}) {
  const units = new Map(), inflight = new Set();   // "floor/unit" → finds
  let workers = [], idle = [], mode = 'starting', where = '', why = '', batch = 1, reach = 0, maxBatch = 8, wordsText = '';
  let here = { floor: 0, unit: 0, y: 0 }, rate = 0, vel = 0, lastY = null, lastT = 0;
  let side = 0;   // which gallery you are in (0 east, 1 west): only its shelves are read, and units are kept for it alone
  // After a teleport: units are local and the shelves are origin + local (see the page). Those books are read by
  // their own CPU workers, a few metres around you only, since each one costs about 50 ms.
  let origin = null, epoch = 0, far = [], farIdle = [], farRate = 0;
  const key = (floor, unit) => `${floor}/${unit}`;
  const cpuWorkers = () => cpuWorkerCount(phone, cores);
  const ready = w => new Promise(r => w.addEventListener('message', function on(e) { if (e.data.t === 'ready') { w.removeEventListener('message', on); r(e.data); } }));

  async function start() {
    try {
      const words = wordsText = await loadWords();
      const pageGpu = force !== 'cpu' && scanners.hasGpu;
      const first = scanners.spawn(); first.postMessage({ t: 'init', words, gpu: pageGpu && force !== 'page', batch: 8 });
      if ((await ready(first)).gpu) { mode = 'gpu'; where = 'worker'; batch = 8; reach = 60; workers = [first]; }
      else if (pageGpu) {   // no GPU in the worker: try the page's
        try {
          const w = await scanners.page(words);
          mode = 'gpu'; where = 'page'; batch = maxBatch = 4; reach = 60; workers = [w]; first.terminate();
        } catch (e) { why = /adapter/i.test(e.message) ? 'blocked' : 'failed'; }
      } else why = force === 'cpu' ? 'forced' : 'none';
      if (mode === 'starting') {
        mode = 'cpu'; batch = 1; reach = 24; workers = [first];
        const n = cpuWorkers();
        for (let i = 1; i < n; i++) { const w = scanners.spawn(); w.postMessage({ t: 'init', words, gpu: false, batch: 1 }); await ready(w); workers.push(w); }
      }
      for (const w of workers) w.addEventListener('message', e => e.data.t === 'done' && done(w, e.data));
      idle = workers.slice(); onChange(); pump();
    } catch (e) { mode = 'off'; onChange(); }
  }

  // A GPU's window follows its measured speed: a slow one reads less far, and in smaller batches so results come
  // back sooner. (Walking costs it about half its speed: the page's rendering shares the GPU.) It reads your own
  // floor only, so another floor's words are found by walking there.
  function tune() {
    if (mode !== 'gpu') return;
    reach = rate >= 20 ? 60 : 30;
    batch = Math.max(2, Math.min(maxBatch, Math.round(rate / 8)));
  }
  // units still to scan on your floor, nearest first to where you will be when they are done
  function wanted() {
    const R = origin ? FAR_REACH : reach;
    const latency = rate ? batch * workers.length / rate : 0;   // seconds from asking a worker for a unit to having it
    const out = [], lead = origin ? 0 : Math.max(-R * 0.75, Math.min(R * 0.75, vel * (LEAD_S + latency))), c = here.y + lead, u0 = here.unit + Math.round(lead);
    for (let du = -R; du <= R; du++) {   // this floor only
      const floor = here.floor, unit = u0 + du, k = key(floor, unit);
      if (!units.has(k) && !inflight.has(k)) out.push({ floor, unit, d: Math.abs(unit + 0.5 - c) });
    }
    return out.sort((a, b) => a.d - b.d);
  }
  function pump() {
    const pool = origin ? farIdle : idle;
    while (pool.length) {
      const take = wanted().slice(0, origin ? 1 : batch);
      if (!take.length) return;
      for (const u of take) inflight.add(key(u.floor, u.unit));
      pool.pop().postMessage({ t: 'scan', epoch, origin, units: take.map(({ floor, unit }) => ({ floor, unit, side })), min: MIN });
    }
  }
  function done(w, m) {
    (far.includes(w) ? farIdle : idle).push(w);
    if (m.epoch !== epoch) { pump(); return; }   // from before a teleport: those shelves are somewhere else now
    for (const { key: k, finds } of m.units) { inflight.delete(k); units.set(k, finds); if (finds.length && !origin) onFinds(finds); }
    if (origin) { const r = m.units.length / m.ms * 1000 * far.length; farRate = farRate ? farRate * 0.7 + r * 0.3 : r; onChange(); pump(); return; }
    const r = m.units.length / m.ms * 1000 * workers.length;
    rate = rate ? rate * 0.8 + r * 0.2 : r;
    tune();
    if (units.size > maxUnits) {
      const far = [...units.keys()].map(k => { const [f, u] = k.split('/').map(Number); return { k, d: Math.abs(u - here.unit) + 20 * Math.abs(f - here.floor) }; })
        .sort((a, b) => b.d - a.d);
      for (const { k } of far.slice(0, units.size - maxUnits * 0.9)) units.delete(k);
    }
    onChange(); pump();
  }
  function setOrigin(o) {
    origin = o; epoch++; units.clear(); inflight.clear(); lastY = null; vel = 0; farRate = 0;
    if (o && !far.length) {
      const n = cpuWorkers();
      for (let i = 0; i < n; i++) {
        const w = scanners.spawn(); far.push(w);
        w.addEventListener('message', e => { if (e.data.t === 'ready') { farIdle.push(w); pump(); } else if (e.data.t === 'done') done(w, e.data); });
        w.postMessage({ t: 'init', words: wordsText, gpu: false, batch: 1 });
      }
    }
    onChange(); pump();
  }

  start();
  return {
    get mode() { return mode; },
    get rate() { return rate; },
    get where() { return where; },   // 'worker' or 'page', with a GPU
    get why() { return why; },       // without one: 'none' (no WebGPU), 'blocked' (no adapter), 'failed', 'forced'
    get speed() { return Math.abs(vel); },
    get far() { return origin ? { workers: far.length, rate: farRate } : null; },
    get workers() { return workers.length; },
    setOrigin,
    // tell it where you are, every frame; it reads outward from there, ahead of you first
    at(floor, y, s = side) {
      if (s !== side) { side = s; epoch++; units.clear(); inflight.clear(); lastY = null; vel = 0; onChange(); pump(); }   // crossed the shaft: other shelves entirely
      const t = now(), unit = Math.floor(y);
      if (lastY !== null && floor === here.floor && t > lastT) {
        const v = (y - lastY) / ((t - lastT) / 1000), k = Math.min(1, (t - lastT) / 400);   // smoothed over ~0.4 s
        if (Math.abs(v) < 20) vel += (v - vel) * k;   // a jump (falling across, a correction) isn't walking
      } else if (floor !== here.floor) vel = 0;
      lastY = y; lastT = t; here.y = y;
      if (floor !== here.floor || unit !== here.unit) { here = { floor, unit, y }; pump(); }
    },
    // the best finds within `metres` along the gallery on this floor (or `df` floors either way), longest first, then nearest
    nearby(floor, y, n = 5, metres = 30, df = 0) {
      const out = [], u0 = Math.floor(y);
      for (let f = floor - df; f <= floor + df; f++) for (let u = u0 - metres; u <= u0 + metres; u++) {
        const l = units.get(key(f, u)); if (l) for (const x of l) out.push(x);
      }
      const dist = x => Math.abs(x.unit + 0.5 - y) + 20 * Math.abs(x.floor - floor);
      return out.sort((a, b) => b.len - a.len || a.words - b.words || dist(a) - dist(b)).slice(0, n);
    },
    // walking: how many of the next 20 m ahead have been read; standing: how far out, either way, all has been
    scannedTo(floor, y) {
      const u0 = Math.floor(y), dir = vel > 0.3 ? 1 : vel < -0.3 ? -1 : 0; let r = 0;
      if (dir) { for (let i = 1; i <= 20; i++) if (units.has(key(floor, u0 + dir * i))) r++; return { metres: r, ahead: true }; }
      while (r <= (origin ? FAR_REACH : reach) && units.has(key(floor, u0 - r)) && units.has(key(floor, u0 + r))) r++;
      return { metres: r, ahead: false };
    },
    // whether a unit has been read (and is still kept), on the side you are on
    has: (floor, unit) => units.has(key(floor, unit)),
    get kept() { return units.size; },
    inBook: a => ((a.side ?? 0) !== side ? [] : units.get(key(a.floor, a.unit)) || []).filter(f => f.shelf === a.shelf && f.slot === a.slot).sort((x, y) => x.page - y.page),
    rarity,
  };
}
