// A shelf scanner off the main thread: on the GPU when the browser has WebGPU here, else on this CPU core.
// finder.js runs one of these with the GPU, or several without.
import { loadWords, scanUnit, byUnit } from './scan.js';
import { bigAddSmall } from './babel.js';
import { createGpuScanner } from './scan-gpu.js';

let words = null, gpu = null;
const KEEP = 8;   // finds kept per unit, best first

onmessage = async ({ data: m }) => {
  if (m.t === 'init') {
    words = loadWords(m.words);
    if (m.gpu) { try { gpu = await createGpuScanner(words, { maxUnits: m.batch }); } catch (e) { gpu = null; } }
    postMessage({ t: 'ready', gpu: !!gpu, workerHasGpu: 'gpu' in navigator });
  } else if (m.t === 'scan') {
    const t0 = performance.now();
    // origin: after a teleport, units are local (0 is where you arrived) and the shelves are origin + local. Far
    // books can have numbers longer than the GPU takes (32 digits), so they are read here, a few ms a book.
    const all = m.origin ? m.units.flatMap(u => scanUnit(bigAddSmall(m.origin.floor, u.floor), bigAddSmall(m.origin.unit, u.unit), words, m.min, u.side)
        .map(f => ({ ...f, floor: u.floor, unit: u.unit })))
      : gpu ? await gpu.scanUnits(m.units, m.min, KEEP) : m.units.flatMap(u => scanUnit(u.floor, u.unit, words, m.min, u.side));
    postMessage({ t: 'done', epoch: m.epoch, units: byUnit(m.units, all, KEEP), ms: performance.now() - t0 });
  }
};
