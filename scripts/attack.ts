// The hostile test: everything a visitor could try against the world with a browser's devtools or a script, each of
// which must fail. Needs `npm run dev` (it sets CF-Connecting-IP itself, which wrangler dev honours and Cloudflare in
// production overwrites). Run: node scripts/attack.ts [base-url]
// Well-formed messages are built with web/protocol.js; the malformed ones are written by hand, since they are the point.
import * as P from '../web/protocol.js';
import { createSession, memoryStorage } from '../web/session.js';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787', WS = BASE.replace(/^http/, 'ws') + '/ws';
const LOCAL = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const run = Math.random().toString(36).slice(2, 8);
let failures = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
type Msg = Record<string, any>;
let ipN = 0;
const freshIp = () => `198.51.${Math.floor(Math.random() * 200)}.${(ipN++ % 250) + 1}`;

function client(hello: Msg | null, ip = freshIp()) {
  // a session (web/session.js, the page's own client) that never reconnects; hello null: it says nothing on open, and
  // malformed frames go out raw (sendRaw), since they are the point. A made-up address only for a local server;
  // Cloudflare refuses a client that sets this header itself.
  const { anon, name, ...extra } = hello ?? {};
  const s = createSession({
    url: WS, wsOptions: LOCAL ? { headers: { 'CF-Connecting-IP': ip } } : undefined, reconnect: false, warn: () => {},
    storage: memoryStorage({ ...(anon ? { anon } : {}), ...(name ? { name } : {}) }), hello: hello ? extra : false,
  });
  const inbox: Msg[] = [];
  let closed: number | null = null;
  s.on('message', (m: Msg) => inbox.push(m));
  s.on('close', (code: number) => { closed = code; });
  const ready = new Promise<boolean>(r => { s.on('open', () => r(true)); s.on('socketError', () => r(false)); });
  const next = async (pred: (m: Msg) => boolean, ms = 2500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; await sleep(15); }
    return null;
  };
  s.connect();
  return { session: s, inbox, ready, next, send: (m: unknown) => s.sendRaw(m), closed: () => closed, close: () => s.close() };
}
let victimSecret = '';   // a returning player: later sections log in as them, since new people are limited per address
const anon = (tag: string) => `atk-${run}-${tag}-${Math.random().toString(36).slice(2, 10)}`;

console.log('\nIdentity');
{
  const secret = victimSecret = anon('victim'), v = client({ anon: secret, name: 'Victim', side: 0 }); const w = await v.next(m => m.t === 'welcome');
  check(w && /^p_[0-9a-f]{16}$/.test(w.you.id), `a player's public id is random (${w?.you.id})`);
  const map = await (await fetch(BASE + '/api/map')).json(), events = await (await fetch(BASE + '/api/events?since=0&limit=500')).json();
  check(!JSON.stringify(map).includes(secret) && map.players.every((p: Msg) => /^(p_|a_)/.test(p.id)), 'GET /api/map carries no secrets');
  check(!JSON.stringify(events).includes(secret) && events.every((e: Msg) => !e.author || /^(p_|a_)/.test(e.author)), 'GET /api/events carries no secrets');
  for (const guess of [w.you.id, w.you.id.slice(2), 'h_' + w.you.id.slice(2)]) {
    const x = client({ anon: guess.replace(/[^A-Za-z0-9_-]/g, '').padEnd(8, '0') }); const wx = await x.next(m => m.t === 'welcome');
    check(wx && wx.you.id !== w.you.id, `logging in with the public id (${guess}) gets someone else`); x.close();
  }
  check(!(await v.next(m => m.t === 'replaced', 400)), 'and the real player is not thrown off');
  v.close();
}

console.log('\nNames');
for (const [given, want] of [['‮evil‬', 'evil'], ['<img src=x onerror=alert(1)>', 'img src=x onerror=alert(1)'], ['a​​b', 'ab'], ['  lots   of   space  ', 'lots of space']] as [string, string][]) {
  const c = client({ anon: anon('name'), name: given }); const w = await c.next(m => m.t === 'welcome');
  check(w?.you.name === want, `the name ${JSON.stringify(given)} arrives as ${JSON.stringify(w?.you.name)}`); c.close();
}
{
  const c = client({ anon: anon('name'), name: '​​​' }); const w = await c.next(m => m.t === 'welcome');
  check(w && /^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/.test(w.you.name), `an invisible name is replaced by a given one (${w?.you.name})`); c.close();
}
for (const slur of ['N1GG3R', 'f.a.g.g.o.t']) {
  const c = client({ anon: anon('name'), name: slur }); const w = await c.next(m => m.t === 'welcome');
  check(w && /^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/.test(w.you.name), `a slur (${slur.replace(/[aeiou1]/gi, '*')}) is replaced by a given name (${w?.you.name})`); c.close();
}

console.log('\nOne address, many sockets and many new people');
{
  const ip = freshIp(), socks = [];
  let refused = 0;
  for (let i = 0; i < 28; i++) { const c = client(null, ip); if (await c.ready) socks.push(c); else refused++; }
  // exactly 24 on a dev server; in production this address may already have a socket or two of its own open
  check(socks.length <= 24 && socks.length >= 20 && refused >= 4, `from one address, at most 24 sockets open and the rest are refused (${socks.length} open, ${refused} refused)`);
  for (const s of socks) s.close();
  await sleep(300);
  const ip2 = freshIp(); let turned = 0, made = 0;
  for (let i = 0; i < 64; i++) {
    const c = client({ anon: anon('flood') }, ip2); const m = await c.next(m => m.t === 'welcome' || (m.t === 'error' && m.for === 'hello'));
    if (m?.t === 'welcome') made++; else if (m?.reason?.includes('too many new')) turned++;
    c.close();
  }
  // exactly 60 on a dev server; in production every client here shares one real address, already used above
  check(made <= 60 && turned >= 4 && made + turned === 64, `one address can make at most 60 new people an hour, then is turned away (${made} made, ${turned} turned away)`);
}

console.log('\nTampered messages');
{
  const c = client({ anon: victimSecret, side: 0 }); const w = await c.next(m => m.t === 'welcome');
  const side = w.you.side ?? 0;   // whichever side it landed on (tests can't choose in production)
  c.send('{not json'); check((await c.next(m => m.t === 'error'))?.reason === 'bad json', 'not JSON: refused');
  c.send(JSON.stringify({ t: 'move', pad: 'x'.repeat(5000) })); check((await c.next(m => m.t === 'error'))?.reason === 'message too large', 'more than 4 KB: refused');
  c.send({ t: 'become-admin' }); check(/unknown message type/.test((await c.next(m => m.t === 'error'))?.reason ?? ''), 'an unknown message type: refused');
  for (const bad of [{ x: 'a', y: 4, floor: 0, yaw: 0 }, { x: -3, y: NaN, floor: 0, yaw: 0 }, { x: -3, y: 4, floor: 0.5, yaw: 0 }, { x: -3, y: 1e15, floor: 0, yaw: 0 }, { x: -3, y: 4, floor: 0, yaw: 0, side: 7 }])
    c.send({ t: 'move', ...bad });
  c.send(P.ping(1));
  check(await c.next(m => m.t === 'pong'), 'nonsense moves are ignored, and the world carries on');
  await sleep(200);
  c.send(P.move({ x: -3.2, y: w.you.y + 500, floor: 0, yaw: 0 }));
  check((await c.next(m => m.t === 'correct'))?.y === w.you.y, 'a 500 m jump is put back');
  await sleep(300);
  c.send(P.move({ x: -3.2, y: w.you.y, floor: 3, yaw: 0 }));
  check((await c.next(m => m.t === 'correct'))?.floor === 0, 'changing floor away from the stairs is put back');
  await sleep(300);
  c.send(P.move({ x: -3.2, y: w.you.y, floor: 0, side: 1 - side, yaw: 0 }));
  check((await c.next(m => m.t === 'correct'))?.side === side, 'changing side without falling across is put back');
  const addr = { floor: 0, unit: Math.floor(w.you.y), side, shelf: 0, slot: 0 };
  c.send(P.finds([P.claim({ ...addr, page: 1, at: 7, len: 30 }), P.claim({ ...addr, floor: 5000, page: 1, at: 7 }), P.claim({ ...addr, side: 1 - side, page: 1, at: 7 })]));
  const f = await c.next(m => m.t === 'found');
  check(f && !f.results[0].ok && !f.results[1].ok && !f.results[2].ok, `made-up and out-of-reach finds are refused (${f?.results.map((r: Msg) => r.reason).join('; ')})`);
  c.send(P.mark({ ...addr, unit: addr.unit + 300 }));
  check((await c.next(m => m.t === 'error' && m.for === 'mark'))?.reason === 'out of reach', 'marking a book 300 m away is refused');
  c.send({ t: 'mark', address: addr, kind: 'note', text: 'hello' });
  check(/notes are gone/.test((await c.next(m => m.t === 'error' && m.for === 'mark'))?.reason ?? ''), 'a note is refused');
  c.send(P.open({ ...addr, floor: 9 }));
  check((await c.next(m => m.t === 'error' && m.for === 'open'))?.reason === 'that book is on another floor', 'opening a book on another floor is refused');
  let rosters = 0; for (let i = 0; i < 20; i++) c.send(P.map());
  await sleep(1200); rosters = c.inbox.filter(m => m.t === 'roster').length;
  check(rosters <= 2, `asking for the roster 20 times at once gets ${rosters}`);
  c.close();
}
{
  const c = client(null); await c.ready; c.send(P.move({ x: -3, y: 4, floor: 0, yaw: 0 })); await sleep(500);
  check(c.closed() === 4003, `talking before hello closes the socket (${c.closed()})`);
}

console.log('\nThe page and the owner\'s doors');
{
  for (const path of ['/', '/short-stay-library']) {
    const r = await fetch(BASE + path), csp = r.headers.get('content-security-policy') ?? '';
    check(/script-src 'self' 'sha256-[^']+';/.test(csp) && !/https:/.test(csp) && /frame-ancestors 'none'/.test(csp) && r.headers.get('x-content-type-options') === 'nosniff',
      `${path} carries a Content-Security-Policy (only this site, scripts by hash, no framing) and nosniff`);
  }
  const html = await (await fetch(BASE + '/short-stay-library')).text();
  check(/src="vendor\/three-[\d.]+\.min\.js" integrity="sha384-/.test(html) && !/(src|href)="https?:/.test(html), 'three.js and the fonts are served from here, three.js pinned by its hash');
  check(!/innerHTML|insertAdjacentHTML|document\.write/.test(html), 'the page never writes HTML from strings');
  for (const [method, path] of [['GET', '/api/admin/diag'], ['POST', '/api/admin/reset'], ['POST', '/api/admin/wipe'], ['POST', '/api/admin/player'], ['GET', '/api/agents'], ['POST', '/api/agents']] as [string, string][]) {
    const r = await fetch(BASE + path, { method, headers: { Authorization: 'Bearer not-the-token' } });
    check(r.status === 401, `${method} ${path} without the owner token: ${r.status}`);
  }
  check((await fetch(BASE + '/mcp', { method: 'POST', body: '{}' })).status === 401, 'POST /mcp without an agent key: 401');
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
