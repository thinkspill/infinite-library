// End-to-end smoke test against a running `wrangler dev` (default http://127.0.0.1:8787).
// Two humans over WebSocket, one agent over MCP. Run: node scripts/smoke.ts [base-url]
import { pageText } from '../web/babel.js';
import * as P from '../web/protocol.js';
import { createSession, memoryStorage } from '../web/session.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OWNER = process.env.OWNER_TOKEN ?? 'dev-owner-token';
let failures = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

type Msg = Record<string, any>;
// side: newcomers toss a coin for their side; tests ask for one (honoured only where ALLOW_SIDE_CHOICE is 1, i.e. dev)
function client(anon: string, name: string, side: number | null = 0) {
  // one session (web/session.js, the page's own client) per person, with no reconnecting; a made-up address per client
  // (honoured by wrangler dev; Cloudflare sets the real one), so per-address limits don't bite
  const s = createSession({
    url: BASE.replace(/^http/, 'ws') + '/ws', storage: memoryStorage({ anon, name }), hello: side === null ? {} : { side }, reconnect: false,
    wsOptions: { headers: { 'CF-Connecting-IP': `198.19.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}` } },
  });
  const inbox: Msg[] = [];
  const waiters: Array<{ pred: (m: Msg) => boolean; res: (m: Msg) => void }> = [];
  s.on('message', (m: Msg) => {
    const w = waiters.find(w => w.pred(m));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.res(m); } else inbox.push(m);
  });
  const next = (pred: (m: Msg) => boolean, ms = 3000) => new Promise<Msg>((res, rej) => {
    const hit = inbox.find(pred); if (hit) { inbox.splice(inbox.indexOf(hit), 1); return res(hit); }
    waiters.push({ pred, res }); setTimeout(() => rej(new Error('timeout waiting for message')), ms);
  });
  const ready = new Promise<void>(r => s.on('open', () => r()));
  s.connect();
  return { session: s, next, ready, send: (m: object) => s.send(m), close: () => s.close(), inbox };
}

let rpcId = 0;
async function mcp(key: string, method: string, params: unknown = {}) {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await r.text();
  const body = text.startsWith('{') ? text : text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop() ?? '{}';
  return { status: r.status, body: JSON.parse(body) };
}
const toolText = (res: any) => res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const suffix = Math.random().toString(36).slice(2, 8);

// ---- page and hello endpoint
const page = await fetch(BASE + '/');
check(page.ok && (await page.text()).includes('A Short Stay in Hell'), 'GET / serves the library page');
check((await (await fetch(BASE + '/api/hello')).json()).ok, 'GET /api/hello');

// ---- two humans
const a = client('smoke-a-' + suffix, 'Soren'), b = client('smoke-b-' + suffix, 'Rachel');
await Promise.all([a.ready, b.ready]);
const wa = await a.next(m => m.t === 'welcome'), wb = await b.next(m => m.t === 'welcome');
check(wa.you.y === 4 && wa.you.floor === 0, 'humans spawn at the same spot');
check(wb.you.name === 'Rachel', 'names carried through');

a.send(P.move({ x: -3.2, y: 5, floor: 0, yaw: 1.57 }));
const peers = await b.next(m => m.t === 'peers' && m.peers.some((p: Msg) => p.name === 'Soren' && p.y === 5));
check(peers, 'B sees A move via peers');

a.send(P.move({ x: -3.2, y: 500, floor: 0, yaw: 1.57 }));
const corr = await a.next(m => m.t === 'correct');
check(corr.y === 5, 'teleport rejected with correct');
await sleep(300);
a.send(P.move({ x: -3.2, y: 5, floor: 1, yaw: 1.57 }));
const up1 = await a.next(m => m.t === 'correct');
check(up1.floor === 0, 'changing floor away from the stairs is refused');

// reach check and marks
await sleep(300);
a.send(P.move({ x: -6.0, y: 5.3, floor: 0, yaw: 3.14 }));
await sleep(150);
const addr = { floor: 0, unit: 5, shelf: 2, slot: 10 };
// ---- names: someone who doesn't choose one gets a random name, never the old "wanderer"
const c = client('smoke-c-' + suffix, '');
const wc = await c.next(m => m.t === 'welcome');
check(/^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/.test(wc.you.name) && wc.you.name !== 'wanderer', `a nameless newcomer is named ${wc.you.name}`);
c.close();

// ---- leaderboard: a real find is credited to whoever claims it first; a made-up one is refused
check(wa.board && Array.isArray(wa.board.top) && wa.board.min >= 9, `welcome carries the leaderboard (min ${wa.board?.min})`);
// finds as of babel.js LIBRARY sides-1: one 6 m from the spawn on the east side; then the same spot on the west side,
// across the shaft, and a spot on floor -2, which nobody here has been near (both refused before anything is scanned)
const feds = P.claim({ floor: 0, unit: 10, side: 0, shelf: 3, slot: 11, page: 201, at: 3064, len: 12 });   // "daub tabs by"
const distant = P.claim({ floor: -2, unit: 20, shelf: 1, slot: 29, page: 321, at: 2870, len: 12 });
const across = { ...feds, address: { ...feds.address, side: 1 } };
a.send(P.finds([feds, { ...feds, at: 3063 }, distant, across]));
const fa = await a.next(m => m.t === 'found');
check(fa.results[0]?.ok && fa.results[0].text === 'daub tabs by' && fa.results[0].side === 'east' && fa.results[0].rank >= 1, `a real find is accepted (#${fa.results[0]?.rank}, first: ${fa.results[0]?.first})`);
check(fa.results[1] && !fa.results[1].ok && fa.results[1].reason === 'no such find', 'a claim that is not a find is refused');
check(fa.results[2] && !fa.results[2].ok && /too far away/.test(fa.results[2].reason), `a real find on a floor you have not been near is refused (${fa.results[2]?.reason})`);
check(fa.results[3] && !fa.results[3].ok && /across the shaft/.test(fa.results[3].reason), `a find on the other side is refused (${fa.results[3]?.reason})`);
b.send(P.finds([feds]));
const fb = await b.next(m => m.t === 'found');
check(fb.results[0]?.ok && fb.results[0].first === false && fb.results[0].finder === fa.results[0].finder, `a second claim keeps the first finder (${fb.results[0]?.finder})`);
const lb = await (await fetch(BASE + '/api/finds')).json();
check(lb.top.some((f: Msg) => f.text === 'daub tabs by') && lb.sides?.[0]?.top.some((f: Msg) => f.text === 'daub tabs by') && lb.sides?.[1]?.name === 'west', 'GET /api/finds lists it, on the east board');

a.send({ t: 'mark', address: addr, kind: 'note', text: 'smoke was here' });   // by hand: protocol.js builds no notes
const noNote = await a.next(m => m.t === 'error' && m.for === 'mark');
check(/notes are gone/.test(noNote.reason), 'leaving a note is refused: notes are gone');
a.send(P.mark(addr));
const marked = await a.next(m => m.t === 'marked' || (m.t === 'error' && m.for === 'mark'));
check(marked.t === 'marked', `A marks a book in reach (${marked.reason ?? 'ok'})`);
const seen = await b.next(m => m.t === 'mark' && m.mark.kind === 'open_book' && m.mark.author === 'Soren');
check(seen, 'B receives the mark');
a.send(P.mark({ ...addr, unit: 100 }));
const far = await a.next(m => m.t === 'error' && m.for === 'mark');
check(far.reason === 'out of reach', 'marking out of reach is refused');


// ---- agent over MCP
const noKey = await fetch(BASE + '/mcp', { method: 'POST', body: '{}' });
check(noKey.status === 401, '/mcp without key is 401');
const minted = await (await fetch(BASE + '/api/agents', { method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: JSON.stringify({ name: 'Smoke Agent ' + suffix, ratePerMin: 120, side: 0 }) })).json();
check(minted.key?.startsWith('ssa_'), 'owner mints an agent key');
const init = await mcp(minted.key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
check(init.body.result?.serverInfo?.name === 'short-stay-library', `MCP initialize (${init.status})`);
const tools = await mcp(minted.key, 'tools/list');
const names = (tools.body.result?.tools ?? []).map((t: Msg) => t.name).sort().join(',');
check(names === 'claim,climb,finds,look,map,mark,open,page,search,walk', `MCP tools: ${names}`);
const look = JSON.parse(toolText(await mcp(minted.key, 'tools/call', { name: 'look', arguments: {} })));
check(look.you.floor === 0 && look.you.metresAlong === 4, 'agent looks from the spawn point');
check(look.peers.some((p: Msg) => p.name === 'Soren'), 'agent sees the humans nearby');

const t0 = Date.now();
const walked = toolText(await mcp(minted.key, 'tools/call', { name: 'walk', arguments: { metres: 3, run: false } }));
const took = Date.now() - t0;
check(walked.startsWith('You walked 3 m') && took >= 1800, `walk takes human time (${took} ms)`);
const bSawAgent = b.inbox.some(m => m.t === 'peers' && m.peers.some((p: Msg) => p.kind === 'agent' && p.state === 'walking'));
check(bSawAgent, 'humans saw the agent walking');

const opened = JSON.parse(toolText(await mcp(minted.key, 'tools/call', { name: 'open', arguments: { shelf: 3, book: 11, unit: 5 } })));
check(opened.text?.length === 40 * 81 - 1 && /^[a-z ,.\n]+$/.test(opened.text), 'agent opens a book: 40 × 80 in the 29 symbols');
check(opened.marks.some((m: Msg) => m.kind === 'open_book' && m.author === 'Soren'), 'agent sees the book the human left standing open');
check(opened.text === pageText({ floor: 0, unit: 5, shelf: 2, slot: 10 }, 1), 'the server reads the same book the page does (babel.js)');
const claimed = toolText(await mcp(minted.key, 'tools/call', { name: 'claim', arguments: { finds: [
  { floor: 0, unit: 3, shelf: 4, book: 3, page: 322, at: 1610 }, { floor: 0, unit: 3, shelf: 4, book: 3, page: 322, at: 1609 },
  { floor: -2, unit: 20, shelf: 2, book: 30, page: 321, at: 2870 }] } }));
const cr = JSON.parse(claimed.slice(claimed.indexOf('[')));
check(cr[0]?.ok && cr[0].text === 'grab grind.' && cr[1] && !cr[1].ok, `agent claims a find without its length, and a wrong spot is refused (${cr[1]?.reason})`);
check(cr[2] && !cr[2].ok && /too far away/.test(cr[2].reason), 'agent: a find two floors down, never visited, is refused');
const fl = JSON.parse(toolText(await mcp(minted.key, 'tools/call', { name: 'finds', arguments: {} })).replace(/^[^{]*/, ''));
check(Array.isArray(fl.board) && fl.board.some((f: Msg) => f.text === 'grab grind.') && fl.you.side === 'east' && fl.near.every((f: Msg) => f.floor === 0 && f.side === 'east') && /characters/.test(fl.claimNeeds), `agent reads the leaderboard (${fl.board.length} finds, ${fl.near.length} near)`);
const found = toolText(await mcp(minted.key, 'tools/call', { name: 'search', arguments: { text: 'smoke was here', page: 7, line: 3, col: 5 } }));
const fr = JSON.parse(found.slice(found.indexOf('{')));
check(fr.page === 7 && fr.pageText.split('\n')[2].slice(4, 18) === 'smoke was here' && /digits/.test(fr.floor), `agent searches: floor ${String(fr.floor).slice(0, 30)}…`);
const lost = await mcp(minted.key, 'tools/call', { name: 'search', arguments: { text: 'abc', line: 5, col: 10 } });
const lost2 = await mcp(minted.key, 'tools/call', { name: 'search', arguments: { text: 'abc', page: 3, col: 10 } });
check(lost.body.result?.isError && /needs page/.test(toolText(lost)) && lost2.body.result?.isError && /needs line/.test(toolText(lost2)),
  'a search with line or col but not what they need is refused, not placed somewhere else');
const p2 = JSON.parse(toolText(await mcp(minted.key, 'tools/call', { name: 'page', arguments: { n: 410 } })));
check(p2.page === 410, 'agent turns to the last page');
const am = await mcp(minted.key, 'tools/call', { name: 'mark', arguments: { kind: 'open_book' } });
check(!am.body.result?.isError, 'agent leaves the book open');
const up = JSON.parse(toolText(await mcp(minted.key, 'tools/call', { name: 'climb', arguments: { where: 'up' } })));
check(up.you.floor === 1, `agent climbs the stairs to floor ${up.you.floor}`);

const map = await (await fetch(BASE + '/api/map')).json();
check(map.players.some((p: Msg) => p.kind === 'agent' && p.floor === 1), '/api/map shows the agent upstairs');
const ev = await (await fetch(BASE + '/api/events?since=0&limit=500')).json();
check(ev.some((e: Msg) => e.type === 'arrive') && ev.some((e: Msg) => e.type === 'mark'), 'events log arrivals and marks');

// ---- the two sides: the only way across is to fall and steer past the middle of the shaft
{
  const c = client('smoke-c-' + suffix, 'Crosser'); await c.ready;
  const wc = await c.next(m => m.t === 'welcome');
  check(wc.you.side === 0, 'a test player can ask for its side (dev only)');
  await sleep(150); c.send(P.move({ x: -3.2, y: 4.5, floor: 0, side: 1, yaw: 0 }));
  const bad = await c.next(m => m.t === 'correct');
  check(bad.side === 0, 'changing sides on foot is refused');
  // over the railing, then steer out over the shaft, under the speed limit
  let x = -3.2; const y = 4;
  for (; x < 14.5; x += 1.4) { await sleep(110); c.send(P.move({ x, y, floor: 0, side: 0, yaw: 0 })); }
  await sleep(300);
  const early = c.inbox.filter(m => m.t === 'correct'); c.inbox.length = 0;
  check(!early.length, `walking to the railing and steering out over the shaft is accepted${early.length ? ` (refused: ${early[0].reason} at x ${early[0].x})` : ''}`);
  const j = Math.floor(y / 20);   // R.acrossShaft: x → 30 − x, y mirrored within its 20 m segment
  await sleep(110); c.send(P.move({ x: 30 - x, y: (2 * j + 1) * 20 - y, floor: 0, side: 1, yaw: Math.PI }));
  const refused = await c.next(m => m.t === 'correct', 700).catch(() => null);
  await sleep(5100); c.send(P.map());   // the roster is rebuilt at most every 5 s (GET /api/map is cached for 10 s)
  const there = (await c.next(m => m.t === 'roster')).players.find((p: Msg) => p.name === 'Crosser');
  check(!refused && there?.side === 1, `falling across the shaft lands on the west side${refused ? ` (refused: ${refused.reason})` : ''}`);
  c.close();
}

// newcomers who don't (and can't, in production) ask: a coin toss each
{
  const sides = await Promise.all(Array.from({ length: 24 }, async (_, i) => {
    const n = client(`smoke-toss-${i}-${suffix}`, `Toss ${i}`, null); await n.ready;
    const w = await n.next(m => m.t === 'welcome'); n.close(); return w.you.side as number;
  }));
  const west = sides.filter(x => x === 1).length;
  check(west > 0 && west < 24, `newcomers land on both sides (${24 - west} east, ${west} west of 24)`);
}

a.close(); b.close();
// leave no agent behind: each run mints one, and left standing at the spawn they would crowd the next run's people
// out of each other's 32 nearest
await fetch(BASE + '/api/agents/' + minted.id, { method: 'DELETE', headers: { Authorization: `Bearer ${OWNER}` } }).catch(() => {});
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
