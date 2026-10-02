// Holds the WebGPU scanner (web/scan-gpu.js) to the CPU one (web/scan.js), find for find, in headless Chrome on
// this machine's GPU, and times both. First the shader's page stream (its probe entry point) must reproduce babel.js's
// known answers (STREAM_VECTORS, as scripts/check-stream.ts holds the CPU copies to) and every page of those books.
// Needs `npm run dev` running and Google Chrome installed.
// Run: node scripts/check-scan-gpu.ts [base-url]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335, sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'scan-gpu-'))}`,
  '--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
try {
  let targets: any[] = [];
  for (let i = 0; i < 50 && !targets.length; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const waiting = new Map<number, (m: any) => void>();
  ws.onmessage = e => { const m = JSON.parse(String(e.data)); waiting.get(m.id)?.(m); waiting.delete(m.id); };
  const send = (method: string, params = {}) => new Promise<any>(r => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Page.navigate', { url: BASE + '/babel.js' }); await sleep(1500);   // any page on the origin will do
  const r = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const [{ loadWords, scanUnit }, { createGpuScanner }, B] = await Promise.all([import('/scan.js'), import('/scan-gpu.js'), import('/babel.js')]);
    const words = loadWords(await (await fetch('/words.txt')).text());
    const gpu = await createGpuScanner(words, { maxUnits: 16 });
    // the stream: the known answers' nearby books (the GPU takes numbers of up to 32 digits), every page's ends
    const V = B.STREAM_VECTORS, HEAD = V.books[0].pages[0].head.length, TAIL = V.books[0].pages[0].tail.length;
    const big = v => typeof v === 'string' ? B.bigFromDecimal(v) : v, str = a => Array.from(a, g => B.ALPHABET[g]).join('');
    const vb = V.books.filter(b => b.m.length <= 32), probed = await gpu.probe(vb.map(b => ({ m: Uint8Array.from(b.m), acc1: b.acc1 })), HEAD, TAIL);
    const streamBad = [];
    vb.forEach((b, i) => {
      const read = B.bookReader({ ...b.address, floor: big(b.address.floor), unit: big(b.address.unit) });
      for (const p of b.pages) { const t = str(probed[i][p.page - 1]); if (t !== p.head + p.tail) streamBad.push('vector ' + i + ' page ' + p.page); }
      for (let p = 1; p <= 410; p++) { const t = read(p).replace(/\\n/g, ''); if (str(probed[i][p - 1]) !== t.slice(0, HEAD) + t.slice(-TAIL)) streamBad.push('book ' + i + ' page ' + p); }
    });
    const stream = { books: vb.length, of: V.books.length, bad: streamBad.slice(0, 5), nbad: streamBad.length };
    const key = f => [f.floor, f.unit, f.shelf, f.slot, f.page, f.at, f.text].join('/');
    const units = [{ floor: 0, unit: 4 }, { floor: -7, unit: -1234 }];
    // 4+ characters: thousands of finds a unit, so page 1 (where the book number's digits are added) is covered too
    let t0 = performance.now(); const g = await gpu.scanUnits(units, 4); const gpuMs = performance.now() - t0;
    t0 = performance.now(); const c = units.flatMap(u => scanUnit(u.floor, u.unit, words, 4)); const cpuMs = performance.now() - t0;
    const gs = new Set(g.map(key)), cs = new Set(c.map(key));
    const batch = Array.from({ length: 16 }, (_, i) => ({ floor: 3, unit: 500 + i }));
    await gpu.scanUnits(batch); t0 = performance.now(); await gpu.scanUnits(batch); const batchMs = performance.now() - t0;
    return { stream, same: gs.size === cs.size && [...gs].every(k => cs.has(k)), finds: c.length, page1: c.filter(f => f.page === 1).length, gpuOnly: [...gs].filter(k => !cs.has(k)).slice(0, 3),
      cpuOnly: [...cs].filter(k => !gs.has(k)).slice(0, 3), cpuMps: 2 / cpuMs * 1000, gpuMps: 16 / batchMs * 1000 };
  })()` });
  const v = r.result?.result?.value;
  if (!v) { console.error('FAIL', r.result?.exceptionDetails?.exception?.description ?? r); process.exitCode = 1; }
  else {
    const st = v.stream;
    console.log(`${st.nbad ? 'FAIL' : 'ok  '} GPU stream reproduces babel.js's known answers: ${st.books} of ${st.of} books (the rest are too far for the GPU), pages 1, 2 and 410, and every page's ends${st.nbad ? ' ' + JSON.stringify(st.bad) : ''}`);
    if (st.nbad) process.exitCode = 1;
    console.log(`${v.same && v.page1 ? 'ok  ' : 'FAIL'} GPU and CPU scanners agree on 2 units (${v.finds} finds of 4+ characters, ${v.page1} on page 1)${v.same ? '' : ' ' + JSON.stringify({ gpuOnly: v.gpuOnly, cpuOnly: v.cpuOnly })}`);
    console.log(`     GPU ${v.gpuMps.toFixed(0)} m/s of shelf, one CPU core ${v.cpuMps.toFixed(2)} m/s`);
    if (!v.same || !v.page1) process.exitCode = 1;
  }
  ws.close();
} finally { chrome.kill(); }
