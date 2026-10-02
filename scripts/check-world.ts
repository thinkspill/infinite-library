// Checks src/world-core.ts, the world behind the Durable Object, offline: a host made of node:sqlite (scripts/
// node-store.ts), fake sockets that record what they are sent, a fake clock and fake timers. Saying hello every way
// there is, moving, claiming, night, moderation, sockets closing, and what waking reads with 2,000 players stored.
// Run: node scripts/check-world.ts
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { WorldCore, sha256, type Host, type Attachment } from '../src/world-core.ts';
import { nodeSql } from './node-store.ts';
import { loadWords, scanPageOf } from '../web/scan.js';
import * as P from '../web/protocol.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const WORDS = loadWords(readFileSync(new URL('../web/words.txt', import.meta.url), 'utf8'));
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0, 500);
const PERIOD = 3600;   // a night an hour

type Msg = Record<string, any>;
class Sock {
  frames: Msg[] = []; att: Attachment | null = null; closedWith: { code: number; reason: string } | null = null;
  name: string;
  constructor(name: string) { this.name = name; }
  last(t: string) { for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].t === t) return this.frames[i]; return undefined; }
  all(t: string) { return this.frames.filter(f => f.t === t); }
}

// ------------------------------------------------------------------ the host
function world(settings: Record<string, string> = {}, db = new DatabaseSync(':memory:'), open: Sock[] = []) {
  let now = T0;
  const timers: { at: number; fn: () => void }[] = [], closing: Sock[] = [];
  const sockets = [...open];
  let alarmAt: number | null = null;
  const sql = nodeSql(db);
  const host: Host<Sock> = {
    sql, now: () => now,
    schedule: (ms, fn) => { timers.push({ at: now + ms, fn }); },
    alarm: { get: async () => alarmAt, set: at => { alarmAt = at; } },
    sockets: {
      list: () => sockets.slice(),
      send: (ws, text) => { if (ws.closedWith) throw new Error('closed'); ws.frames.push(JSON.parse(text)); },
      close: (ws, code, reason) => { if (!ws.closedWith) { ws.closedWith = { code, reason }; closing.push(ws); } },
      attachment: ws => ws.att,
      attach: (ws, a) => { ws.att = { ...a }; },
    },
    settings: { NIGHT_PERIOD_S: String(PERIOD), ALLOW_SIDE_CHOICE: '1', ...settings },
    words: WORDS,
  };
  const core = new WorldCore(host);
  let n = 0;
  const w = {
    core, db, sql, host, sockets,
    get now() { return now; },
    get alarmAt() { return alarmAt; },
    // time passes: timers fall due in order (and those they set, if due)
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift()!; now = Math.max(now, t.at); t.fn();
      }
      now = end;
    },
    // closes the world asked for, and any others, arrive (each once as close and, for some, again as error)
    deliverCloses(alsoError = false) {
      while (closing.length) { const ws = closing.shift()!; sockets.splice(sockets.indexOf(ws), 1); core.closed(ws); if (alsoError) core.closed(ws); }
    },
    clientClose(ws: Sock, alsoError = false) { ws.closedWith = { code: 1000, reason: 'bye' }; closing.push(ws); w.deliverCloses(alsoError); },
    connect(ip = '10.0.0.1') {
      const r = core.connect(ip, () => { const s = new Sock('s' + ++n); sockets.push(s); return s; });
      return r.ok ? r.ws : null;
    },
    async say(ws: Sock, m: object) { await core.message(ws, JSON.stringify(m)); },
    async hello(o: { anon?: string; token?: string; name?: string; side?: number }, ip?: string) {
      const ws = w.connect(ip)!; await w.say(ws, P.hello({ side: 0, ...o })); return ws;
    },
    row: (q: string, ...b: (string | number | null)[]) => db.prepare(q).get(...b) as Msg | undefined,
  };
  return w;
}
type W = ReturnType<typeof world>;
const anon = (i: number | string) => `anon-secret-${i}`;

console.log('Hello');
{
  const w = world(); await w.core.wake();
  check(w.alarmAt !== null && w.alarmAt > T0 && w.alarmAt <= T0 + PERIOD * 1000, 'waking sets the night alarm');
  const a = await w.hello({ anon: anon(1), side: 1 });
  const you = a.last('welcome')?.you;
  check(you && you.kind === 'human' && you.side === 1 && /^p_/.test(you.id) && you.name && you.name !== 'wanderer', `a new person is welcomed with a public id, the side asked for and a random name (${you?.name})`);
  const r = w.row('SELECT * FROM players WHERE pub_id = ?', you.id)!;
  check(r.secret_hash === await sha256('anon:' + anon(1)) && r.connected === 1 && !r.id.includes(anon(1)), 'stored by the hash of their secret, connected; the secret is in no id');
  check(a.last('marks')?.replace === true && a.last('welcome').board?.sides?.length === 2, 'and sent the marks around them and the board');
  // returning
  await w.say(a, P.move({ x: -3, y: 6, floor: 0, yaw: 0 }));
  w.clientClose(a);
  w.advance(1000);
  check(w.core.people.get(r.id as string) && w.row('SELECT connected FROM players WHERE id = ?', r.id as string)!.connected === 0, 'leaving, they are stored as not connected, and held while their trail could back a claim');
  w.advance(60_000); w.core.flush();
  check(!w.core.people.get(r.id as string), 'a minute on, they are let go (back to the store)');
  const b = await w.hello({ anon: anon(1), name: 'Returner' });
  const back = b.last('welcome')?.you;
  check(back?.id === you.id && back.name === 'Returner' && back.y === 6 && back.side === 1, 'returning by their secret, they are who and where they were, under the name they chose');
  // legacy: a player from before secrets, id 'h_' + secret, no hash
  w.db.prepare(`INSERT INTO players (id, kind, name, x, y, floor, yaw, updated_at, side, pub_id) VALUES (?, 'human', 'Old Timer', -3, 9, 2, 0, ?, 0, 'p_oldtimer')`).run('h_' + anon('old'), T0);
  const c = await w.hello({ anon: anon('old') });
  const rk = c.last('rekey'), oy = c.last('welcome')?.you;
  check(rk && typeof rk.anon === 'string' && rk.anon !== anon('old') && oy?.id === 'p_oldtimer' && oy.floor === 2 && oy.name === 'Old Timer', 'a legacy secret is let in once, as themselves, and handed a new one (rekey)');
  w.clientClose(c);
  const d = await w.hello({ anon: rk.anon });
  check(d.last('welcome')?.you.id === 'p_oldtimer' && !d.last('rekey'), 'the new secret logs in');
  const e = await w.hello({ anon: anon('old') });
  check(e.last('welcome')?.you.id !== 'p_oldtimer', 'the old one is just a newcomer now');
  // agents
  const minted = await w.core.mintAgent('Robot', 60, 1);
  const ag = await w.hello({ token: minted.key });
  check(ag.last('welcome')?.you.kind === 'agent' && ag.last('welcome')?.you.id === minted.id && ag.last('welcome')?.you.side === 1, 'an agent says hello with its key');
  const bad = await w.hello({ token: 'ssa_' + '0'.repeat(48) });
  check(bad.last('error')?.reason === 'unknown or revoked key' && !bad.last('welcome'), 'an unknown key is refused');
  w.core.revokeAgent(minted.id);
  check(ag.closedWith?.code === 4006, `revoking the key closes the agent's open socket too (${ag.closedWith?.code} ${ag.closedWith?.reason})`);
  w.deliverCloses();
  const rev = await w.hello({ token: minted.key });
  check(rev.last('error')?.reason === 'unknown or revoked key', 'a revoked one too');
  const none = w.connect()!; await w.say(none, { t: 'hello' });
  check(none.last('error')?.reason === P.REASON.needAnon, 'no secret, no key: refused');
  const early = w.connect()!; await w.say(early, P.ping(1));
  check(early.last('error')?.reason === P.REASON.helloFirst && early.closedWith?.code === 4003, 'a message before hello: refused and closed (4003)');
  // names
  const rude = await w.hello({ anon: anon('rude'), name: 'n1gg3r' });
  const rn = rude.last('welcome')?.you.name;
  check(rn && !/n1gg/i.test(rn) && rn !== 'wanderer', `a blocked name is replaced by a random one (${rn})`);
  const named = await w.hello({ anon: anon('named'), name: '  Mary​  Ann ' });
  check(named.last('welcome')?.you.name === 'Mary Ann', 'names are cleaned (invisible characters, spaces)');
  // second tab
  const tab2 = await w.hello({ anon: anon('named') });
  check(named.last('replaced') && named.closedWith?.code === 4000 && tab2.last('welcome')?.you.name === 'Mary Ann', 'a second tab replaces the first (4000), keeping the name');
  w.deliverCloses();
  const mid = w.core.people.get(w.row("SELECT id FROM players WHERE name = 'Mary Ann'")!.id as string);
  check(mid?.connected && w.core.people.isOnline(mid.id), "the first tab's close leaves them connected through the second");
}

console.log('\nThe crowd and the address limits');
{
  const w = world({ MAX_HUMANS: '3' }); await w.core.wake();
  const s = [];
  for (let i = 0; i < 3; i++) s.push(await w.hello({ anon: anon('c' + i) }, `10.1.0.${i}`));
  const full = await w.hello({ anon: anon('c3') }, '10.1.0.9');
  check(full.last('full')?.retryInS === 120 && full.closedWith?.code === 4002 && !full.last('welcome'), 'at MAX_HUMANS connected, a newcomer is told the night is full (4002)');
  const tab = await w.hello({ anon: anon('c1') }, '10.1.0.9');
  check(tab.last('welcome') && s[1].closedWith?.code === 4000, 'but a returning tab of someone connected is let in (and replaces their first)');
  check(w.core.diag().cap === 3 && w.core.diag().online === 3, 'diag says the cap in effect, and how many are online');
  w.deliverCloses();
  w.clientClose(s[0]);
  check(w.core.diag().online === 2 && !w.core.people.isOnline(w.core.people.withPub(s[0].last('welcome').you.id)!.id), 'leaving, they no longer count toward the cap');
  const now = await w.hello({ anon: anon('c3') }, '10.1.0.9');
  check(now.last('welcome'), 'when someone leaves, there is room');

  const v = world({ NEW_PER_IP_HOUR: '3' }); await v.core.wake();
  const got = [];
  for (let i = 0; i < 4; i++) got.push(await v.hello({ anon: anon('n' + i) }, '10.2.0.1'));
  check(got.slice(0, 3).every(g => g.last('welcome')) && got[3].last('error')?.reason.startsWith('too many new arrivals') && got[3].closedWith?.code === 4004,
    'from one address, the 4th new person in an hour is refused (4004) at NEW_PER_IP_HOUR 3');
  const ret = await v.hello({ anon: anon('n0') }, '10.2.0.1');
  check(ret.last('welcome'), 'someone returning from that address is not new');
  const other = await v.hello({ anon: anon('n9') }, '10.2.0.2');
  check(other.last('welcome'), 'another address is not limited by it');
  v.advance(3600_000);
  check((await v.hello({ anon: anon('n5') }, '10.2.0.1')).last('welcome'), 'an hour later, there is room again');

  const u = world({ SOCKETS_PER_IP: '2' }); await u.core.wake();
  const k1 = u.connect('10.3.0.1'), k2 = u.connect('10.3.0.1'), k3 = u.connect('10.3.0.1');
  check(k1 && k2 && k3 === null && u.connect('10.3.0.2'), 'at most SOCKETS_PER_IP sockets from one address (2): the third is refused');
  u.clientClose(k1!, true);   // a close and an error for the same socket
  const k4 = u.connect('10.3.0.1'), k5 = u.connect('10.3.0.1');
  check(k4 && k5 === null, 'a socket that closes and errors is counted out once');
}

console.log('\nMoving');
{
  const w = world(); await w.core.wake();
  const a = await w.hello({ anon: anon('m1'), side: 0 }), b = await w.hello({ anon: anon('m2'), side: 0 });
  w.advance(500);
  await w.say(a, P.move({ x: -3, y: 4.5, floor: 0, yaw: 0, vy: 1 }));
  check(!a.last('correct'), 'a walk at walking pace is accepted');
  w.advance(100);
  await w.say(a, P.move({ x: -3, y: 60, floor: 0, yaw: 0 }));
  const c = a.last('correct');
  check(c?.reason === 'too fast' && c.y === 4.5 && c.floor === 0, 'a leap is corrected back to where the world has them');
  w.advance(1000);
  const peers = b.all('peers').at(-1);
  check(peers && peers.peers.some((p: Msg) => p.name === a.last('welcome').you.name), 'others nearby are told of them (peers)');
  check(!peers.peers.some((p: Msg) => p.id === b.last('welcome').you.id), 'and nobody is sent themselves');
}

// A real find near the spawn: the first page of a book at unit 4 with a run of at least 9 characters.
function findNear(side: number) {
  for (let slot = 0; slot < 32; slot++) for (let page = 1; page <= 410; page++) {
    const addr = { floor: 0, unit: 4, side, shelf: 0, slot };
    const f = scanPageOf(addr, page, WORDS, 9)[0];
    if (f) return { addr, page, at: f.at as number, len: f.len as number, text: f.text as string };
  }
  throw new Error('no find');
}

console.log('\nClaiming a find');
{
  const w = world(); await w.core.wake();
  const f = findNear(0);
  const a = await w.hello({ anon: anon('f1'), side: 0, name: 'Finder' }), b = await w.hello({ anon: anon('f2'), side: 0, name: 'Second' });
  await w.say(a, P.finds([P.claim({ ...f.addr, page: f.page, at: f.at, len: f.len }), P.claim({ ...f.addr, page: f.page, at: f.at + 1, len: f.len }),
    P.claim({ ...f.addr, unit: 5000, page: f.page, at: f.at, len: f.len }), { address: { floor: 0 }, page: 1, at: 0 }]));
  const res = a.last('found')?.results;
  check(res?.[0].ok && res[0].first && res[0].rank === 1 && res[0].text === f.text && res[0].finder === 'Finder', `a real find is credited, first, rank 1 ("${f.text}")`);
  check(res?.[1].reason === 'no such find' && /too far away/.test(res?.[2].reason) && res?.[3].reason === 'bad claim', 'a wrong place, a far one and a malformed one are refused, each in its place');
  check(a.last('found').board.sides[0].top[0]?.text === f.text, 'the reply carries the new board');
  w.advance(2000);
  check(b.last('board')?.board.sides[0].top[0]?.finder === 'Finder', 'and everyone is sent it');
  await w.say(b, P.finds([P.claim({ ...f.addr, page: f.page, at: f.at, len: f.len })]));
  const again = b.last('found')?.results[0];
  check(again?.ok && !again.first && again.finder === 'Finder', 'claiming it again: the first finder keeps it');
  const west = await w.hello({ anon: anon('f3'), side: 1 });
  await w.say(west, P.finds([P.claim({ ...f.addr, page: f.page, at: f.at, len: f.len })]));
  check(/across the shaft/.test(west.last('found')?.results[0].reason), 'from across the shaft: not yours to claim');
  check(w.row("SELECT COUNT(*) AS n FROM events WHERE type = 'find'")!.n === 1, 'one find event');
}

console.log('\nNight');
{
  const w = world(); await w.core.wake();
  const a = await w.hello({ anon: anon('n1'), side: 0 });
  // over the railing: to the edge, then out
  w.advance(1000); await w.say(a, P.move({ x: -0.5, y: 4, floor: 0, yaw: 0 }));
  w.advance(500); await w.say(a, P.move({ x: 0.5, y: 4, floor: 0, yaw: 0 }));
  check(!a.last('correct') && w.row("SELECT COUNT(*) AS n FROM events WHERE type = 'fall'")!.n === 1, 'a person goes over the railing (a fall event)');
  const ag = await w.core.mintAgent('Faller', 600, 0);
  w.core.agentClimb(ag.id, 'railing');
  w.advance(5000);
  check(w.core.agentLook(ag.id).you.state === 'falling', 'an agent goes over too');
  // someone who fell and left, in the store only
  w.db.prepare(`INSERT INTO players (id, kind, name, x, y, floor, yaw, updated_at, side, pub_id) VALUES ('h_gone', 'human', 'Gone', 4, 30, -7, 0, ?, 0, 'p_gone')`).run(T0 - 86400_000);
  const stander = await w.hello({ anon: anon('n2'), side: 0 });
  await w.say(stander, P.mark({ floor: 0, unit: 4, side: 0, shelf: 0, slot: 0 }));
  check(stander.last('marked'), 'a mark is left');
  const before = w.row('SELECT COUNT(*) AS n FROM marks')!.n;
  w.advance(w.alarmAt! - w.now); await w.core.alarm();
  check(a.last('night') && stander.last('night') && w.alarmAt! > w.now, 'night falls for everyone, and the next is set');
  const corr = a.last('correct');
  check(corr?.reason === 'night' && corr.x === -3.2 && corr.floor === 0, 'the person in the shaft is put back on the gallery of their floor');
  const agent = w.core.agentLook(ag.id).you;
  check(agent.state === 'standing' && agent.floor < 0, `the falling agent stands on the floor it fell to (${agent.floor})`);
  const gone = w.row("SELECT x, floor, y FROM players WHERE id = 'h_gone'")!;
  check(gone.x === -3.2 && gone.floor === -7 && gone.y === 30, 'and so is someone who fell and left (from the store)');
  check(before === 1 && w.row('SELECT COUNT(*) AS n FROM marks')!.n === 0 && stander.last('marks')?.marks.length === 0, "the night's marks are gone, and everyone is re-sent theirs");
  check(JSON.parse(w.row("SELECT payload FROM events WHERE type = 'night'")!.payload as string).restored === 3, 'three restored');
}

console.log('\nMarks are told by where people are now');
{
  const w = world(); await w.core.wake();
  const human = await w.hello({ anon: anon('k1'), side: 0 });
  const ag = await w.core.mintAgent('Walker', 600, 0);
  const sock = await w.hello({ token: ag.key });   // the agent's own socket, to hear marks on
  let r = w.core.agentWalk(ag.id, 126, true); w.advance(r.arriveAt - w.now);
  r = w.core.agentWalk(ag.id, 126, true); w.advance(r.arriveAt - w.now);
  r = w.core.agentWalk(ag.id, -126, true);   // from 256 back toward 130
  w.advance((r.arriveAt - w.now) / 2);
  check(Math.abs(w.core.agentLook(ag.id).you.metresAlong - 193) < 0.1, 'the agent is half way back, at 193');
  const heard = sock.all('mark').length;
  await w.say(human, P.mark({ floor: 0, unit: 4, side: 0, shelf: 0, slot: 1 }));
  check(human.last('mark') && sock.all('mark').length === heard, 'a mark at unit 4 is not told to it (189 m from where it is, though its walk ends 126 m away)');
  w.advance(r.arriveAt - w.now);
  await w.say(human, P.mark({ floor: 0, unit: 4, side: 0, shelf: 0, slot: 2 }));
  check(sock.all('mark').length === heard + 1, 'arrived at 130, it is told of the next');
}

console.log("\nAn agent's look");
{
  const w = world(); await w.core.wake();
  const ag = await w.core.mintAgent('Looker', 600, 0);
  const near = await w.hello({ anon: anon('l1'), side: 0, name: 'Near' }), far = await w.hello({ anon: anon('l2'), side: 0, name: 'Far' });
  const across = await w.hello({ anon: anon('l3'), side: 1, name: 'Across' });
  w.advance(1000); await w.say(far, P.move({ x: -3, y: 6, floor: 0, yaw: 0 }));
  for (let i = 0; i < 20; i++) { w.advance(1000); await w.say(far, P.move({ x: -3, y: 6 + 4 * (i + 1), floor: 0, yaw: 0 })); }
  const peers = w.core.agentLook(ag.id).peers.map((p: Msg) => p.name);
  check(peers.includes('Near') && !peers.includes('Far') && !peers.includes('Across'), `look names those on its side within 60 m, nobody across the shaft (${peers})`);
  void near; void across;
}

console.log('\nModeration');
{
  const w = world(); await w.core.wake();
  const f = findNear(0);
  const a = await w.hello({ anon: anon('x1'), side: 0, name: 'Rude Name' });
  const id = a.last('welcome').you.id;
  const r = w.core.moderate(id, { rename: '' });
  check('renamed' in r && r.from === 'Rude Name' && r.to !== 'Rude Name' && a.closedWith?.code === 4005, `rename gives a random name and closes their sockets (4005): ${'to' in r ? r.to : ''}`);
  w.deliverCloses();
  const b = await w.hello({ anon: anon('x1'), name: 'Rude Name' });
  check(b.last('welcome')?.you.name === (r as Msg).to, 'the name is locked: the one their browser sends is ignored');
  await w.say(b, P.finds([P.claim({ ...f.addr, page: f.page, at: f.at, len: f.len })]));
  await w.say(b, P.mark({ floor: 0, unit: 4, side: 0, shelf: 0, slot: 0 }));
  const pid = w.row('SELECT id FROM players WHERE pub_id = ?', id)!.id as string;
  check(w.row('SELECT COUNT(*) AS n FROM finds WHERE finder = ?', pid)!.n === 1, 'they find something');
  const off = w.core.moderate(id, { remove: true });
  check('removed' in off && off.findsDeleted === 1 && b.closedWith?.code === 4005, 'remove deletes them and their finds, and closes their sockets');
  w.deliverCloses();
  check(!w.row('SELECT 1 AS x FROM players WHERE pub_id = ?', id) && !w.row('SELECT 1 AS x FROM marks WHERE author = ?', pid), 'and their socket closing does not write them back');
  check('error' in w.core.moderate('p_nobody', { remove: true }), 'an unknown id: no such player');
}

console.log('\nWaking with 2,000 players stored');
{
  const db = new DatabaseSync(':memory:');
  { const w = world({}, db); await w.core.wake(); }   // a current world
  db.exec('BEGIN');
  const ins = db.prepare(`INSERT INTO players (id, kind, name, x, y, floor, yaw, updated_at, side, pub_id, secret_hash, connected) VALUES (?,?,?,-3,?,0,0,?,0,?,?,?)`);
  for (let i = 0; i < 2000; i++) ins.run(`h_${i}`, i % 100 ? 'human' : 'agent', `Name ${i}`, i, T0 - i * 60_000, `p_${i}`, i % 100 ? `hash${i}` : null, i < 300 ? 1 : 0);   // 300 stale 'connected'
  const key = db.prepare('INSERT INTO agent_keys (key_hash, player_id, name, rate_per_min, created_at) VALUES (?,?,?,60,?)');
  for (let i = 0; i < 2000; i += 100) key.run(`key${i}`, `h_${i}`, `Name ${i}`, T0);   // 20 agents: h_0 seen just now, the rest an hour or more ago
  db.exec('COMMIT');
  const open: Sock[] = [];
  for (const i of [1, 2, 3, 5, 8]) { const s = new Sock('old' + i); s.att = { pid: `h_${i}`, ip: '10.9.0.1' }; open.push(s); }
  const w = world({}, db, open);
  await w.core.wake();
  const read = w.sql.log.reduce((n, l) => n + l.estRead, 0);
  check(read <= 3 + 5 + 20 + 1 && w.sql.log.every(l => !l.scans.includes('players')),
    `a wake reads who is here, not everyone: ${w.sql.log.length} queries, ~${read} rows of 2,000 players (${w.sql.log.map(l => l.q.slice(0, 50) + ' ~' + l.estRead).join(' | ')})`);
  check(w.core.people.size === 6 && w.core.people.humansOnline === 5 && [1, 2, 3, 5, 8].every(i => w.core.people.get(`h_${i}`)?.connected) && w.core.people.get('h_0'),
    'holding the 5 whose sockets are open (connected, online) and the 1 agent seen in the last 10 minutes');
  const ops = w.core.store.costsSinceWake();
  check(!('loadPlayers' in ops) && ops.wakePlayers?.rowsRead <= 26, `diag's ops show it (wakePlayers ~${ops.wakePlayers?.rowsRead} rows)`);
  // the open sockets carry on: their players are the ones held
  await w.say(open[0], P.ping(1));
  check(open[0].last('pong'), 'a socket from before the wake carries on');
  // the roster: a store query, at most 500 of the last 30 days, with the present marked
  const from = w.sql.log.length;
  const roster = w.core.map().players;
  check(roster.length === 500 && roster[0].updatedAt >= roster[499].updatedAt && roster.filter((p: Msg) => p.present).length === 6,
    `the map's roster is the 500 most recent, latest first, the 6 held marked present (${roster.filter((p: Msg) => p.present).length})`);
  w.advance(6000); w.core.map();
  check(w.sql.log.slice(from).filter(l => /FROM players/.test(l.q)).length === 1, 'read from the store once a wake: later rosters are kept fresh by saves');
  // names: a random one is checked against the store, not just those held
  const names = new Set(w.db.prepare('SELECT name FROM players').all().map(r => (r as Msg).name));
  let clash = 0; for (let i = 0; i < 200; i++) if (names.has(w.core.randomName())) clash++;
  check(clash === 0, 'a random name is never one already in the store');
  const d = w.core.diag();
  check(d.players.n === 2000 && d.inMemory.n === 6 && d.cap === 400, `diag counts players from the store (${d.players.n}), those held (${d.inMemory.n}), and the cap (${d.cap})`);
  // a stale 'connected' row is not someone here
  const stale = await w.hello({ anon: 'nobody-has-this-1' });
  check(stale.last('welcome') && w.core.people.humansOnline === 6, 'the 300 stored as connected but with no socket here do not count toward the cap');
  const ops2 = w.core.store.costsSinceWake().playerCounts;
  check(w.core.diag().players.n === 2001 && w.core.store.costsSinceWake().playerCounts.calls === ops2.calls, 'the count keeps up with a newcomer without counting again');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
