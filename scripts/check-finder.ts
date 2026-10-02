// Checks web/finder.js, the planner that decides which shelf units the phrase finder reads next, with no browser:
// its workers are fakes that answer scan-worker.js's messages when told to, and its clock is a number moved by hand.
// Walking reads ahead, standing reads nearest first, a teleport or a fall across the shaft drops what was in flight,
// a floor change starts over there, what is kept stays under its cap, and a phone reads with one CPU worker.
// Run: node scripts/check-finder.ts
import { createFinder, cpuWorkerCount, FAR_REACH } from '../web/finder.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const tick = () => new Promise(r => setTimeout(r, 0));

type Msg = { t: string; [k: string]: any };
type Unit = { floor: number; unit: number; side: number };
// A worker that answers init at once (with `gpu` if asked for it and the fake has one) and holds every scan until
// the test answers it.
class FakeWorker {
  listeners = new Set<(e: { data: Msg }) => void>();
  scans: Msg[] = [];
  terminated = false;
  gpu: boolean; log: Msg[];
  constructor(gpu: boolean, log: Msg[]) { this.gpu = gpu; this.log = log; }
  addEventListener(_: string, f: (e: { data: Msg }) => void) { this.listeners.add(f); }
  removeEventListener(_: string, f: (e: { data: Msg }) => void) { this.listeners.delete(f); }
  emit(data: Msg) { for (const f of [...this.listeners]) f({ data }); }
  terminate() { this.terminated = true; }
  postMessage(m: Msg) {
    if (m.t === 'init') queueMicrotask(() => this.emit({ t: 'ready', gpu: this.gpu && m.gpu }));
    else if (m.t === 'scan') { this.scans.push(m); this.log.push(m); }
  }
  // answer the oldest scan: each unit gets the finds `findsFor` makes (none by default); `epoch` overrides
  answer(findsFor: (u: Unit) => object[] = () => [], ms = 100, epoch?: number) {
    const m = this.scans.shift(); if (!m) throw new Error('no scan to answer');
    this.emit({ t: 'done', epoch: epoch ?? m.epoch, ms, units: m.units.map((u: Unit) => ({ key: `${u.floor}/${u.unit}`, finds: findsFor(u) })) });
    return m;
  }
}
function setup(o: { gpu?: boolean; phone?: boolean; cores?: number; maxUnits?: number } = {}) {
  const spawned: FakeWorker[] = [], finds: object[][] = [], log: Msg[] = [];
  let t = 1000;
  const scanners = { hasGpu: !!o.gpu, spawn: () => { const w = new FakeWorker(!!o.gpu, log); spawned.push(w); return w; }, page: async () => { throw new Error('no page GPU in tests'); } };
  const finder = createFinder({ scanners, loadWords: async () => 'cat\ndog\n', now: () => t, phone: !!o.phone, cores: o.cores ?? 4, maxUnits: o.maxUnits, onFinds: (f: object[]) => finds.push(f) });
  const clock = { get t() { return t; }, set t(v) { t = v; } };
  const scans = () => spawned.flatMap(w => w.scans);
  // answer whichever scan was asked for first
  const answerOldest = (f?: (u: Unit) => object[]) => { const m = log.find(m => spawned.some(w => w.scans[0] === m))!; return spawned.find(w => w.scans[0] === m)!.answer(f); };
  return { finder, spawned, finds, clock, scans, log, answerOldest };
}
const find = (u: Unit, len = 9) => ({ floor: u.floor, unit: u.unit, side: u.side, shelf: 0, slot: 0, page: 1, at: 0, len, words: 2, text: 'x'.repeat(len) });

console.log('Starting');
{
  const { finder, spawned } = setup({ cores: 8 }); await tick(); await tick();
  check(finder.mode === 'cpu' && spawned.length === 6 && finder.workers === 6, `no GPU, 8 cores: six CPU workers (${finder.mode}, ${spawned.length})`);
  const p = setup({ phone: true, cores: 8 }); await tick(); await tick();
  check(p.finder.mode === 'cpu' && p.spawned.length === 1, `a phone reads with one CPU worker (${p.spawned.length})`);
  check(cpuWorkerCount(true, 16) === 1 && cpuWorkerCount(false, 2) === 1 && cpuWorkerCount(false, 4) === 2, 'worker counts: phone 1, two cores 1, four cores 2');
  const g = setup({ gpu: true }); await tick(); await tick();
  check(g.finder.mode === 'gpu' && g.finder.where === 'worker' && g.spawned.length === 1, `with a GPU in the worker: one GPU worker (${g.finder.mode}/${g.finder.where})`);
  check(g.scans()[0]?.units.length === 8, `and it asks for 8 units at a time (${g.scans()[0]?.units.length})`);
  const off = createFinder({ scanners: { hasGpu: false, spawn: () => new FakeWorker(false, []), page: async () => null }, loadWords: async () => { throw new Error('offline'); }, now: () => 0 });
  await tick();
  check(off.mode === 'off', 'no word list: the finder is off');
}

console.log('\nStanding: nearest first');
{
  const { finder, log, answerOldest } = setup({ cores: 4 });   // two CPU workers, one unit each
  finder.at(0, 100.3, 0); await tick(); await tick();
  const asked = log.map(m => m.units[0].unit);
  check(asked.length === 2 && asked[0] === 100 && asked[1] === 99, `the first two asked for: units 100 and 99 (${asked})`);
  const order: number[] = [];
  for (let i = 0; i < 12; i++) order.push(answerOldest().units[0].unit);
  const d = order.map(u => Math.abs(u + 0.5 - 100.3));
  check(d.every((x, i) => i === 0 || x >= d[i - 1] - 1e-9), `answered one by one, the next asked for is never nearer than the last (${order})`);
  check(finder.scannedTo(0, 100.3).metres >= 3 && !finder.scannedTo(0, 100.3).ahead, `standing: read out to ${finder.scannedTo(0, 100.3).metres} m either way`);
}

console.log('\nWalking forward at 4 m/s: ahead first');
{
  const { finder, spawned, clock } = setup({ cores: 4 });
  finder.at(0, 0, 0); await tick(); await tick();   // both workers now busy with units near 0
  for (let i = 1; i <= 120; i++) { clock.t += 1000 / 60; finder.at(0, 4 * i / 60, 0); }   // two seconds of walking
  check(Math.abs(finder.speed - 4) < 0.2, `its speed is measured: ${finder.speed.toFixed(2)} m/s`);
  const y = 8;
  spawned[0].answer(); const next = spawned[0].scans[0].units[0].unit;
  check(next > y + 10, `the next unit asked for is well ahead of you at ${y} m: unit ${next}`);
  spawned[1].answer(); const next2 = spawned[1].scans[0].units[0].unit;
  check(next2 > y + 10 && next2 !== next, `and the one after that too: unit ${next2}`);
  for (let i = 0; i < 20; i++) for (const w of spawned) if (w.scans.length) w.answer();
  check(finder.scannedTo(0, y).ahead, 'walking, scannedTo counts the metres ahead');
  const back = setup({ cores: 4 }); back.finder.at(0, 0, 0); await tick(); await tick();
  for (let i = 1; i <= 120; i++) { back.clock.t += 1000 / 60; back.finder.at(0, -4 * i / 60, 0); }
  back.spawned[0].answer();
  check(back.spawned[0].scans[0].units[0].unit < -18, `walking the other way, behind you comes first: unit ${back.spawned[0].scans[0].units[0].unit}`);
  const g = setup({ gpu: true }); g.finder.at(0, 0, 0); await tick(); await tick();
  for (let i = 1; i <= 120; i++) { g.clock.t += 1000 / 60; g.finder.at(0, 4 * i / 60, 0); }
  g.spawned[0].answer(() => [], 80); const batch = g.spawned[0].scans[0].units.map((u: Unit) => u.unit);
  check(batch.length >= 2 && batch.every((u: number) => u > y + 20), `on a GPU (100 units a second), the whole next batch is ahead: ${batch}`);
}

console.log('\nFinds');
{
  const { finder, spawned, finds } = setup({ cores: 3 });
  finder.at(2, 50.5, 0); await tick(); await tick();
  spawned[0].answer(u => [find(u, 12)]);
  check(finds.length === 1 && (finds[0][0] as { len: number }).len === 12, 'onFinds receives what a worker found');
  const n = finder.nearby(2, 50.5);
  check(n.length === 1 && n[0].unit === 50 && finder.inBook({ floor: 2, unit: 50, shelf: 0, slot: 0 }).length === 1, 'nearby() and inBook() return it');
  spawned[0].answer(() => []);
  check(finds.length === 1, 'a unit with nothing in it is not offered');
}

console.log('\nA teleport: stale results are dropped');
{
  const { finder, spawned, finds } = setup({ cores: 4 });
  finder.at(0, 10, 0); await tick(); await tick();
  const home = spawned.slice();
  finder.setOrigin({ floor: '123456789', unit: '987654321' });
  home[0].answer(u => [find(u)]);
  check(finds.length === 0 && finder.nearby(0, 10).length === 0, 'a result from before the teleport is neither kept nor offered');
  await tick();
  const farW = spawned.slice(home.length);
  check(farW.length === 2 && finder.far?.workers === 2, `far shelves get their own CPU workers (${farW.length})`);
  const fs = farW.flatMap(w => w.scans);
  check(fs.length === 2 && fs.every(m => m.origin?.unit === '987654321' && m.units.length === 1), 'they read one unit each, with the origin');
  check(fs.every(m => Math.abs(m.units[0].unit - 10) <= FAR_REACH), `within ${FAR_REACH} m of you (${fs.map(m => m.units[0].unit)})`);
  farW[0].answer(u => [find(u)]);
  check(finder.nearby(0, 10).length === 1 && finds.length === 0, 'far finds are kept, but not offered to the board (their addresses are local)');
  finder.setOrigin(null);
  farW[1].answer(u => [find(u)]);
  check(finder.nearby(0, 10).length === 0, 'and back home, the far worker still in flight is dropped too');
}

console.log('\nAcross the shaft: a side change clears everything');
{
  const { finder, spawned, finds, log } = setup({ cores: 4 });   // two workers
  finder.at(0, 10.5, 0); await tick(); await tick();
  spawned[0].answer(u => [find(u)]);
  check(finder.nearby(0, 10.5).length === 1, 'a find on the east side');
  const mark = log.length;
  finder.at(0, 10.5, 1);
  check(finder.nearby(0, 10.5).length === 0 && finder.inBook({ floor: 0, unit: 10, shelf: 0, slot: 0, side: 1 }).length === 0, 'after falling across, nothing kept');
  spawned[1].answer(u => [find(u)]);
  check(finder.nearby(0, 10.5).length === 0 && finds.length === 1, 'an east result arriving late is dropped');
  const since = log.slice(mark);
  check(since.length > 0 && since.every(m => m.units.every((u: Unit) => u.side === 1)), `and everything asked for since is on the west side (${since.length})`);
}

console.log('\nAnother floor');
{
  const { finder, spawned, clock } = setup({ cores: 3 });
  finder.at(0, 0, 0); await tick(); await tick();
  for (let i = 1; i <= 60; i++) { clock.t += 1000 / 60; finder.at(0, 4 * i / 60, 0); }
  check(finder.speed > 3, 'walking on floor 0');
  clock.t += 16; finder.at(1, 4, 0);
  check(finder.speed === 0, 'on reaching floor 1, its speed starts again from 0');
  spawned[0].answer();
  const m = spawned[0].scans[0];
  check(m && m.units.every((u: Unit) => u.floor === 1) && Math.abs(m.units[0].unit - 4) <= 1, `and the next unit asked for is beside you on floor 1 (${m?.units[0].floor}/${m?.units[0].unit})`);
}

console.log('\nKeeping no more than the cap');
{
  const cap = 100, { finder, spawned } = setup({ cores: 3, maxUnits: cap });
  finder.at(0, 500.5, 0); await tick(); await tick();
  // one worker's answer carrying many units, near and far: more than the cap
  const m = spawned[0].scans.shift()!;
  const many = [];
  for (let u = 0; u < 1000; u += 5) many.push({ key: `0/${u}`, finds: [] });
  for (const f of [1, 30]) many.push({ key: `${f}/500`, finds: [] });
  spawned[0].emit({ t: 'done', epoch: m.epoch, ms: 100, units: many });
  check(finder.kept <= cap * 0.9 + 1, `over the cap (${many.length}), it is cut back to 90% of it: ${finder.kept}`);
  check(finder.has(0, 500) && finder.has(0, 495) && finder.has(0, 505) && finder.has(1, 500), 'the nearest are kept (a floor away counts as 20 m)');
  check(!finder.has(0, 0) && !finder.has(0, 995) && !finder.has(30, 500), 'the farthest are gone (30 floors away counts as 600 m)');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
