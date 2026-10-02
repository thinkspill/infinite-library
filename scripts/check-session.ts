// Checks web/session.js, the one client of the world's protocol, with no server: a fake WebSocket, a fake clock and
// fake timers. Saying hello, the welcome, when move reports are due, the claim queue's pacing, reconnecting (backing
// off, a full world, another tab), and rekeying. Run: node scripts/check-session.ts
import { createSession, memoryStorage, moveDue, CLAIM_EVERY_S, CLAIMS_PER_SEND, BACKOFF_MAX_MS, FULL_RETRY_MS } from '../web/session.js';
import { EXTRAPOLATE_S } from '../web/geometry.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
type Msg = Record<string, any>;

// ---- the fakes
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: Msg[] = []; raw: string[] = []; closed = false;
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null; onerror: (() => void) | null = null;
  url: string; opts: unknown;
  constructor(url: string, opts?: unknown) { this.url = url; this.opts = opts; FakeSocket.all.push(this); }
  send(s: string) { this.raw.push(s); try { this.sent.push(JSON.parse(s)); } catch { /* raw */ } }
  close(code = 1000) { if (this.closed) return; this.closed = true; this.onclose?.({ code }); }
  open() { this.onopen?.(); }
  recv(m: Msg) { this.onmessage?.({ data: JSON.stringify(m) }); }
  of(t: string) { return this.sent.filter(m => m.t === t); }
}
let clock = 0;
let timers: Array<{ at: number; f: () => void; id: number }> = [], tid = 0;
const fakeSetTimeout = (f: () => void, ms: number) => { const id = ++tid; timers.push({ at: clock + ms, f, id }); return id; };
const fakeClearTimeout = (id: number) => { timers = timers.filter(t => t.id !== id); };
const advance = (ms: number) => {   // run the clock forward, firing timers as they come due
  const end = clock + ms;
  for (;;) {
    const next = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    timers = timers.filter(t => t !== next); clock = next.at; next.f();
  }
  clock = end;
};
const pendingWaits = () => timers.map(t => t.at - clock);

const side = (min: number) => ({ name: 'x', min, top: [] });
const board = (east: number, west: number) => ({ top: [], min: Math.min(east, west), sides: [side(east), side(west)] });
const you = { id: 'p_0123456789abcdef', kind: 'human', name: 'Soren', x: -3.2, y: 4, floor: 0, side: 0, yaw: 1.57, state: 'standing' };
const welcome = (o: Msg = {}) => ({ t: 'welcome', you: { ...you, ...o }, night: 7, nextAt: 1e12, rules: { walk: 1.5, run: 4.2 }, board: board(12, 14) });

function fresh(o: Msg = {}) {
  FakeSocket.all = []; timers = []; clock = 1000;
  const storage = o.storage ?? memoryStorage({ anon: 'anon-secret-1234', name: 'Soren' });
  const s = createSession({ url: 'ws://test/ws', WebSocket: FakeSocket, now: () => clock, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, storage, warn: () => {}, ...o });
  s.connect();
  return { s, storage, ws: () => FakeSocket.all[FakeSocket.all.length - 1] };
}
const still = (o: Msg = {}) => ({ x: -3.2, y: 4, floor: 0, side: 0, yaw: 1.57, vx: 0, vy: 0, reading: false, ...o });
// tick at 60 fps for ms milliseconds of fake time, the body given by a function of the time; returns the moves sent
function run(s: any, ms: number, bodyAt: (t: number) => Msg) {
  const ws = FakeSocket.all[FakeSocket.all.length - 1], before = ws.sent.length, dt = 1 / 60;
  for (let t = 0; t < ms; t += 1000 * dt) { advance(1000 * dt); s.tick(dt, bodyAt(clock)); }
  return ws.sent.slice(before).filter(m => m.t === 'move');
}

console.log('Hello and welcome');
{
  const { s, ws } = fresh({ hello: { side: 1 } });
  check(ws().url === 'ws://test/ws' && !ws().sent.length, 'connects to the url, says nothing before the socket opens');
  ws().open();
  const h = ws().sent[0];
  check(h?.t === 'hello' && h.anon === 'anon-secret-1234' && h.name === 'Soren' && h.side === 1, `on open: hello with the stored anon and name (and extras) (${JSON.stringify(h)})`);
  s.send({ t: 'map' });
  check(ws().sent.length === 1 && !s.online, 'nothing else is sent before the welcome');
  let got: any = null, online: boolean | null = null, msgs = 0;
  s.on('welcome', (m: Msg, x: Msg) => { got = { m, x }; }); s.on('online', (on: boolean) => { online = on; }); s.on('message', () => msgs++);
  ws().recv(welcome());
  check(s.online && online === true && s.you?.id === you.id && s.night === 7 && s.board?.sides[1].min === 14, 'welcome: online, you, the night and the board are set');
  check(got && got.m.you.name === 'Soren' && got.x.nameChanged === false && msgs === 1, 'welcome is emitted (the name unchanged), then message');
}
{
  const storage = memoryStorage({ name: 'Bad Name' });
  const { s, ws } = fresh({ storage, randomBytes: (n: number) => new Uint8Array(n).fill(171) });
  ws().open();
  check(ws().sent[0].anon === 'ab'.repeat(12) && storage.get('anon') === 'ab'.repeat(12), 'no stored secret: one is made and kept');
  let changed: boolean | null = null; s.on('welcome', (_m: Msg, x: Msg) => { changed = x.nameChanged; });
  ws().recv(welcome({ name: 'Bad' }));
  check(changed === true && storage.get('name') === 'Bad', 'a name the world changed is kept as the world has it');
  const nameless = fresh({ storage: memoryStorage({ anon: 'anon-secret-1234' }) }); nameless.ws().open();
  let ch2: boolean | null = null; nameless.s.on('welcome', (_m: Msg, x: Msg) => { ch2 = x.nameChanged; });
  nameless.ws().recv(welcome({ name: 'Given Name' }));
  check(ch2 === true && nameless.storage.get('name') === null && !('name' in nameless.ws().sent[0]), 'no name chosen: the given one shows, and is not stored as chosen');
}

console.log('\nMove reports');
{
  const { s, ws } = fresh(); ws().open(); ws().recv(welcome());
  const first = run(s, 200, () => still());
  check(first.length === 1 && first[0].x === -3.2 && first[0].vx === 0, 'the first tick after the welcome reports where you are');
  check(run(s, 4500, () => still()).length === 0, 'standing still: nothing for 4.5 s');
  const hb = run(s, 1000, () => still());
  check(hb.length === 1, 'standing still: a report every 5 s');
  // walking steadily: the world's guess stays right, so a report every 2 s, never more
  const t0 = clock, walk = (t: number) => still({ y: 4 + 1.5 * (t - t0) / 1000, vy: 1.5 });
  const start = run(s, 100, walk);
  check(start.length === 1 && start[0].vy === 1.5, 'starting to walk: reported at once');
  const steady = run(s, 1800, walk);
  check(steady.length === 0, `walking steadily: nothing under the 2 s heartbeat (${steady.length})`);
  const beat = run(s, 6100, walk);
  check(beat.length === 3, `walking steadily for 6 s: one every 2 s (${beat.length})`);
  // a drift: the body slips 0.6 m from where the last report carried forward says
  const t1 = clock, drift = (t: number) => still({ y: 4 + 1.5 * (t - t0) / 1000 + ((t - t1) > 300 ? 0.6 : 0), vy: 1.5 });
  const d = run(s, 500, drift);
  check(d.length === 1, `drifting half a metre from the world's guess: a report (${d.length})`);
  // a velocity change: walking to running
  const t2 = clock, y2 = s.lastSent.y, runIt = (t: number) => still({ y: y2 + 4.2 * (t - t2) / 1000, vy: 4.2 });
  const r = run(s, 150, runIt);
  check(r.length === 1 && r[0].vy === 4.2, 'breaking into a run: a report at once');
  const stop = run(s, 150, () => still({ y: 10, vy: 0.01 }));
  check(stop.length === 1 && stop[0].vy === 0, 'stopping (under 5 cm/s counts as still): a report, velocity 0');
  // the horizon: the world carries a report forward at most EXTRAPOLATE_S, and so does the session's guess of it
  const L = { t: 'move', x: -3, y: 0, floor: 0, side: 0, yaw: 0, vx: 0, vy: 1, reading: false, at: 0 } as any;
  const at = (s: number) => still({ x: -3, y: Math.min(s, EXTRAPOLATE_S), yaw: 0, vy: 1 });   // stopped by a wall at the horizon, still pushing
  check(!moveDue(at(1.9), L, 1900) && moveDue(at(2.1), L, 2100), `moveDue: a 2 s heartbeat while moving (horizon ${EXTRAPOLATE_S} s)`);
  check(!moveDue(still({ x: -3, y: 0.4, yaw: 0, vy: 1 }), L, 0) && moveDue(still({ x: -3, y: 0.6, yaw: 0, vy: 1 }), L, 0), 'moveDue: half a metre out is due');
  check(moveDue(still({ x: -3, y: 0, yaw: 0, vy: 1, floor: 1 }), L, 10) && moveDue(still({ x: -3, y: 0, yaw: 0, vy: 1, reading: true }), L, 10)
    && moveDue(still({ x: 1, y: 0, yaw: 0, vy: 1 }), L, 10) && moveDue(still({ x: -3, y: 0, yaw: 0, vy: 1, side: 1 }), L, 10), 'moveDue: a floor, a book, the railing, a side: due at once');
  check(!moveDue(still({ x: -3, y: 0.3, yaw: 0.5, vy: 1 }), L, 300) && moveDue(still({ x: -3, y: 0.6, yaw: 0.5, vy: 1 }), { ...L, y: 0.6, at: 600 } as any, 1200), 'moveDue: looking round is due after half a second');
}
{
  const away = { on: false };
  const { s, ws } = fresh({ paused: () => away.on }); ws().open(); ws().recv(welcome());
  away.on = true;
  const last = s.lastSent;
  check(run(s, 300, () => still({ y: 900 })).length === 0 && s.lastSent === last, 'paused (teleported away): nothing is sent, and the far pose is not taken for a report');
}
{
  // claims found just before a teleport wait for coming home (they were taken off the queue into a paused socket)
  const away = { on: false };
  const { s, ws } = fresh({ paused: () => away.on }); ws().open(); ws().recv(welcome());
  s.offer([{ side: 0, floor: 0, unit: 5, shelf: 1, slot: 2, page: 3, at: 4, len: 30 }]);
  away.on = true;
  run(s, 12000, () => still());
  check(ws().of('finds').length === 0 && s.claims.length === 1, 'while away, queued claims stay queued (none sent, none dropped)');
  away.on = false;
  run(s, 5200, () => still());
  check(ws().of('finds').length === 1 && s.claims.length === 0, 'and go out once home');
}

console.log('\nClaims');
{
  const { s, ws } = fresh(); ws().open();
  const find = (i: number, len: number, sd = 0) => ({ side: sd, floor: 0, unit: i, shelf: 1, slot: 2, page: 3, at: 4, len });
  s.offer([find(1, 30)]);
  check(s.claims.length === 0, 'nothing is queued before the welcome (no board)');
  ws().recv(welcome());
  // east needs 12, west 14
  s.offer([find(1, 11), find(2, 12), find(3, 13, 1), find(4, 14, 1), find(2, 12)]);
  check(s.claims.length === 2 && s.claims.map((c: Msg) => c.unit).join() === '4,2', `filtered by each side's board minimum, offered once, longest first (${s.claims.map((c: Msg) => c.unit)})`);
  s.offer(Array.from({ length: 30 }, (_, i) => find(100 + i, 20 + i)));
  const finds = () => ws().of('finds');
  run(s, CLAIM_EVERY_S * 1000 - 100, () => still());
  check(finds().length === 0, 'none in the first 5 s online');
  run(s, 200, () => still());
  check(finds().length === 1 && finds()[0].finds.length === CLAIMS_PER_SEND && finds()[0].finds[0].address.unit === 129, `claims go at most ${CLAIMS_PER_SEND} at a time, the longest first, after 5 s`);
  run(s, 4800, () => still());
  check(finds().length === 1, 'and no more within 5 s');
  run(s, 400, () => still());
  check(finds().length === 2 && finds()[1].finds.length === 8, 'the next 8 after 5 s');
  run(s, 20000, () => still());
  check(finds().length === 4 && s.claims.length === 0 && finds()[3].finds.length === 8, `then until the queue is empty (${finds().map((f: Msg) => f.finds.length)})`);
  check(finds()[0].finds[0].address.side === 0 && typeof finds()[0].finds[0].page === 'number', 'claims are sent as protocol claims');
}

console.log('\nReconnecting');
{
  const { s, ws } = fresh(); const first = ws(); first.open(); first.recv(welcome());
  let offline = false; s.on('online', (on: boolean) => { if (!on) offline = true; });
  const waits: number[] = [];
  first.close(1006);
  check(offline && !s.online && pendingWaits()[0] === 1000, 'a dropped socket: offline, retry in 1 s');
  for (let i = 0; i < 7; i++) { waits.push(pendingWaits()[0]); advance(pendingWaits()[0]); ws().close(1006); }
  check(waits.join() === '1000,2000,4000,8000,16000,30000,30000', `backoff doubles up to ${BACKOFF_MAX_MS / 1000} s (${waits})`);
  advance(pendingWaits()[0]); ws().open();
  ws().close(1006);
  check(pendingWaits()[0] === 1000, 'an open resets the backoff');
}
{
  const { s, ws } = fresh(); ws().open();
  let fullSeen = false; s.on('full', () => { fullSeen = true; });
  ws().recv({ t: 'full', retryInS: 120 }); ws().close(4002);
  check(fullSeen && pendingWaits()[0] === FULL_RETRY_MS, `full: try again after ${FULL_RETRY_MS / 1000} s`);
  const n = FakeSocket.all.length;
  advance(FULL_RETRY_MS - 1); check(FakeSocket.all.length === n, 'not before');
  advance(1); check(FakeSocket.all.length === n + 1 && !s.full, 'and then connects again (no longer full)');
  ws().close(1006); check(pendingWaits()[0] === 1000, 'the next drop backs off as usual');
}
{
  const { s, ws } = fresh(); ws().open(); ws().recv(welcome());
  let rep = false; s.on('replaced', () => { rep = true; });
  ws().recv({ t: 'replaced' }); ws().close(4000);
  check(rep && s.replaced && timers.length === 0, 'replaced by another tab: no reconnecting');
}
{
  const { s, ws } = fresh(); ws().open(); s.close();
  check(timers.length === 0 && !s.online, 'close(): no reconnecting');
  const r = fresh({ reconnect: false }); r.ws().open(); r.ws().close(1006);
  check(timers.length === 0, 'reconnect: false: none either');
  const re = fresh(); re.ws().open(); re.ws().recv(welcome());
  const n = FakeSocket.all.length; re.s.restart(); advance(1000);
  check(FakeSocket.all.length === n + 1, 'restart(): a new socket after the usual wait');
}

console.log('\nRekey and the rest');
{
  const { s, ws, storage } = fresh(); ws().open(); ws().recv(welcome());
  ws().recv({ t: 'rekey', anon: 'new-secret-5678' });
  check(storage.get('anon') === 'new-secret-5678', 'rekey: the new secret is stored');
  ws().close(1006); advance(1000); ws().open();
  check(ws().sent[0].anon === 'new-secret-5678', 'and the next hello uses it');
  ws().recv(welcome());
  let marks = 0; s.on('marks', () => marks++);
  const mk = (id: number) => ({ id, night: 7, side: 0, floor: 0, unit: 4, shelf: 1, slot: id, kind: 'open_book', text: '', author: 'Soren', createdAt: 0 });
  ws().recv({ t: 'marks', replace: true, marks: [mk(1), mk(2)] }); ws().recv({ t: 'mark', mark: mk(3) });
  check(s.marks.size === 3 && marks === 2, 'marks and a mark: kept, emitted');
  let night: Msg | null = null; s.on('night', (m: Msg) => { night = m; });
  ws().recv({ t: 'night', n: 8, nextAt: 2e12 });
  check(night && s.marks.size === 0 && s.night === 8 && s.nextAt === 2e12 && marks === 3, 'night: every mark is gone');
  let boards = 0; s.on('board', () => boards++);
  ws().recv({ t: 'found', results: [], board: board(20, 21) });
  check(boards === 1 && s.board.sides[0].min === 20, 'found carries the new board');
  ws().recv({ t: 'peers', at: 0, peers: [{ ...you, id: 'a' }, { ...you, id: 'b' }, { id: 'no position' }] });
  check(s.others === 2, 'peers: the count of others (a person who can\'t be read is left out)');
  s.sendRaw('{not json'); s.sendRaw({ t: 'become-admin' });
  check(ws().raw.slice(-2).join('|') === '{not json|{"t":"become-admin"}', 'sendRaw sends frames as given');
  ws().onmessage!({ data: 'not json' });
  check(s.online, 'a frame that is not JSON is ignored');
}
{
  // every frame is read through Proto.read: a malformed one is logged with its reason and dropped, emitting nothing
  const warned: string[] = [], { s, ws } = fresh({ warn: (...a: unknown[]) => warned.push(a.join(' ')) }); ws().open(); ws().recv(welcome());
  const seen: Msg[] = []; s.on('message', (m: Msg) => seen.push(m));
  ws().recv({ t: 'night', n: 'eight', nextAt: 2e12 }); ws().recv({ t: 'welcome', you: null }); ws().recv({ t: 'teleport' }); ws().onmessage!({ data: '[1,2]' });
  check(seen.length === 0 && s.night === 7 && warned.length === 4 && /night: n: not a number/.test(warned[0]) && /unknown message type teleport/.test(warned[2]),
    `malformed frames are logged and dropped (${warned.join(' / ')})`);
  ws().recv({ t: 'night', n: 8, nextAt: 2e12, newField: { x: 1 } });
  check(s.night === 8 && seen.length === 1 && !('newField' in seen[0]), 'a field the client doesn\'t know is tolerated (and dropped)');
  ws().recv({ t: 'full' });
  check(s.full && seen[1]?.retryInS === 120, 'a missing optional field gets its default (full: retry in 120 s)');
}
{
  const { s, ws } = fresh({ hello: false }); ws().open();
  check(ws().sent.length === 0, 'hello: false says nothing on open');
  s.sendRaw({ t: 'move' }); check(ws().sent.length === 1, 'but raw frames go');
}

console.log(`\n${passed} passed${failures ? `, ${failures} failed` : ''}`);
process.exit(failures ? 1 : 0);
