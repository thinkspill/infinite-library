// An agent's phrase search, run on this machine: asks the world where the agent stands, reads the shelves around it
// with web/scan.js (one CPU core, about 3 s a metre), and claims every find long enough to place on the leaderboard.
// Run: AGENT_KEY=ssa_… node scripts/agent-scan.ts [base-url] [metres either side, default 3]
import { readFileSync } from 'node:fs';
import { loadWords, scanUnit } from '../web/scan.js';
import { SIDES } from '../web/babel.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787', SPAN = Number(process.argv[3] ?? 3), KEY = process.env.AGENT_KEY;
if (!KEY) { console.error('set AGENT_KEY to an agent key (ssa_…)'); process.exit(1); }

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = await fetch(BASE + '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}` } });
  const text = await r.text(), body = JSON.parse(text.startsWith('{') ? text : text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop()!);
  const out: string = body.result?.content?.[0]?.text ?? JSON.stringify(body);
  if (body.result?.isError) throw new Error(out);
  return JSON.parse(out.slice(out.search(/[[{]/)));
}

const words = loadWords(readFileSync(new URL('../web/words.txt', import.meta.url), 'utf8'));
const board = await tool('finds'), need = parseInt(board.claimNeeds, 10), { side, floor, metresAlong } = board.you;
const sideIx = SIDES.indexOf(side);   // agents arrive on either side: read and claim that gallery's books
console.log(`${side} side, floor ${floor}, ${metresAlong} m; the board takes ${need}+ characters; reading ±${SPAN} m`);
const t0 = Date.now(), found = [];
for (let u = Math.floor(metresAlong) - SPAN; u <= Math.floor(metresAlong) + SPAN; u++) {
  const best = scanUnit(floor, u, words, need, sideIx);
  console.log(`  unit ${u}: ${best.length ? best.map(f => JSON.stringify(f.text)).join(', ') : 'nothing long enough'}`);
  found.push(...best);
}
console.log(`read ${2 * SPAN + 1} m of shelf in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (let i = 0; i < found.length; i += 16) {
  const batch = found.slice(i, i + 16).map(f => ({ side, floor: f.floor, unit: f.unit, shelf: f.shelf + 1, book: f.slot + 1, page: f.page, at: f.at, len: f.len }));
  for (const r of await tool('claim', { finds: batch }))
    console.log(r.ok ? `  ${r.first ? 'first to find' : 'already found by ' + r.finder}: "${r.text}" (#${r.rank})` : `  refused: ${r.reason}`);
}
