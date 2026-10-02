// Checks web/protocol.js, the wire protocol the page, the scripts and the world share, with no server: every builder's
// message reads back through decode() + validate() as itself, and the malformed messages scripts/attack.ts sends are
// refused (or ignored) for the reasons the world gives; and the other way, every world message's builder reads back
// through read() as itself, read() tolerates fields it doesn't know and refuses malformed frames with a reason, and
// everything src/*.ts sends has a builder. Run: node scripts/check-protocol.ts
import { readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import * as P from '../web/protocol.js';

let failures = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const read = (m: unknown) => { const d = P.decode(typeof m === 'string' ? m : P.encode(m as object)); return d.ok ? P.validate(d.msg) : d; };

// ---- every builder round-trips
const addr = { floor: -3, unit: 1234567, side: 1, shelf: 5, slot: 31 };
const rt: Array<[string, object, object]> = [
  ['hello (browser)', P.hello({ anon: 'abcdef0123456789', name: 'Soren', side: 0 }), { t: 'hello', anon: 'abcdef0123456789', name: 'Soren', side: 0 }],
  ['hello (agent key)', P.hello({ token: 'ssa_' + '0'.repeat(48) }), { t: 'hello', token: 'ssa_' + '0'.repeat(48) }],
  ['move', P.move({ x: -3.21234, y: 5.00049, floor: 2, side: 1, yaw: 1.5708, vx: 0.123, vy: -4.2, reading: true }),
    { t: 'move', x: -3.212, y: 5, floor: 2, yaw: 1.571, side: 1, vx: 0.12, vy: -4.2, reading: true }],
  ['open', P.open(addr), { t: 'open', address: addr }],
  ['page', P.page(410), { t: 'page', n: 410 }],
  ['close', P.close(), { t: 'close' }],
  ['mark', P.mark(addr), { t: 'mark', address: addr, kind: 'open_book' }],
  ['map', P.map(), { t: 'map' }],
  ['ping', P.ping(12345), { t: 'ping', at0: 12345 }],
];
for (const [what, built, want] of rt) {
  const r = read(built);
  check(r.ok && same(r.msg, want), `${what} round-trips: ${P.encode(built)}`);
}
{
  const m = P.move({ x: -3.2, y: 4, floor: 0, yaw: 0 }), r = read(m);
  check(!('side' in m) && !('vx' in m) && r.ok && same(r.msg, { t: 'move', x: -3.2, y: 4, floor: 0, yaw: 0, side: undefined, vx: 0, vy: 0, reading: false }),
    'a bare move leaves side to the world and reads as still, not reading');
  const f = { floor: 0, unit: 10, side: 0, shelf: 3, slot: 11, page: 201, at: 3064, len: 12 }, c = P.claim(f);
  check(same(c, { address: { floor: 0, unit: 10, side: 0, shelf: 3, slot: 11 }, page: 201, at: 3064, len: 12 }), 'claim() turns a find into the claim shape');
  const noLen = P.claim({ floor: 0, unit: 3, shelf: 4, slot: 2, page: 322, at: 1610 });
  check(!('len' in noLen) && noLen.address.side === 0, 'a claim without len leaves it out, and a missing side is east');
  const r2 = read(P.finds([c, noLen]));
  check(r2.ok && r2.msg.t === 'finds' && r2.msg.finds.length === 2 && r2.msg.finds.every(x => x.ok) && same((r2.msg.finds[0] as { claim: object }).claim, c),
    'finds round-trips, each claim checked');
  check(same(P.ping(), { t: 'ping' }) && (read(P.ping()) as { msg: { at0?: number } }).msg.at0 === undefined, 'a ping without at0');
  check(same(P.hello({ anon: 'abcdefgh', name: '' }), { t: 'hello', anon: 'abcdefgh' }), 'an empty name is left out of hello');
}

// ---- framing: the world's first three checks
check(same(read('{not json'), { ok: false, reason: 'bad json' }), 'not JSON: bad json');
check(same(read(JSON.stringify({ t: 'move', pad: 'x'.repeat(5000) })), { ok: false, reason: 'message too large' }), 'more than 4 KB: message too large');
check(same(P.decode('x'.repeat(4096)), { ok: false, reason: 'bad json' }) && same(P.decode(new ArrayBuffer(8)), { ok: false, reason: 'message too large' }),
  'exactly 4096 characters is read; a binary frame is refused as too large');
check(same(read('null'), { ok: false, reason: null }) && same(read('3'), { ok: false, reason: null }), 'JSON that is not an object is ignored without a word');
check(same(read({ t: 'become-admin' }), { ok: false, reason: 'unknown message type become-admin' }), 'an unknown type: unknown message type become-admin');
check(same(read({}), { ok: false, reason: 'unknown message type undefined' }), 'no type at all: unknown message type undefined');

// ---- hello
check(same(read({ t: 'hello' }), { ok: false, for: 'hello', reason: 'need anon id or token' }), 'hello with neither: need anon id or token');
check(same(read({ t: 'hello', anon: 'short' }), { ok: false, for: 'hello', reason: 'need anon id or token' }), 'hello with a secret under 8 characters is refused');
check(!read({ t: 'hello', anon: 'a'.repeat(65) }).ok && !read({ t: 'hello', anon: 'abc def ghi' }).ok && read({ t: 'hello', anon: 'a'.repeat(64) }).ok, 'secrets are 8-64 of A-Z a-z 0-9 _ -');
check(read({ t: 'hello', token: 'anything', anon: 'bad' }).ok, 'a token is tried before the secret (the world judges the key)');

// ---- move: the nonsense attack.ts sends is ignored (no reply), as the world ignores it
const base = { t: 'move', x: -3, y: 4, floor: 0, yaw: 0 };
for (const [what, bad] of [['x a string', { x: 'a' }], ['y NaN', { y: NaN }], ['floor 0.5', { floor: 0.5 }], ['y 1e15', { y: 1e15 }], ['side 7', { side: 7 }],
  ['yaw missing', { yaw: undefined }], ['floor a string', { floor: '0' }], ['x Infinity', { x: Infinity }], ['floor unsafe', { floor: 2 ** 60 }]] as [string, object][])
  check(same(read({ ...base, ...bad }), { ok: false, reason: null }), `move with ${what}: ignored`);
check(read({ ...base, y: 1e12, side: 1 }).ok, 'move at y 1e12 on the west side is read');
{
  const r = read({ ...base, vx: 'fast', vy: 1e300 });
  check(r.ok && r.msg.t === 'move' && r.msg.vx === 0 && r.msg.vy === 1e300, 'a velocity that is not a number reads as 0 (the world caps the rest)');
}

// ---- open, page, mark, finds
check(same(read({ t: 'open', address: { ...addr, side: 7 } }), { ok: false, for: 'open', reason: 'bad address' }), 'open side 7: bad address');
for (const [what, a] of [['shelf 6', { ...addr, shelf: 6 }], ['slot -1', { ...addr, slot: -1 }], ['floor 0.5', { ...addr, floor: 0.5 }], ['unit a string', { ...addr, unit: '1' }], ['nothing', null]] as [string, unknown][])
  check(same(read({ t: 'open', address: a }), { ok: false, for: 'open', reason: 'bad address' }), `open with ${what}: bad address`);
check(same((read({ t: 'open', address: { floor: 0, unit: 4, shelf: 0, slot: 0, junk: 1 } }) as { msg: object }).msg, { t: 'open', address: { floor: 0, unit: 4, side: 0, shelf: 0, slot: 0 } }),
  'an address reads as its five fields, side made explicit');
check(same(read({ t: 'page', n: 9999 }), { ok: true, msg: { t: 'page', n: 410 } }) && same(read({ t: 'page', n: -3 }), { ok: true, msg: { t: 'page', n: 1 } }), 'page numbers are kept within 1-410');
check(same(read({ t: 'page', n: 2.5 }), { ok: false, reason: null }) && same(read({ t: 'page' }), { ok: false, reason: null }), 'a page that is not a whole number is ignored');
check(same(read({ t: 'mark', address: addr, kind: 'note', text: 'hello' }), { ok: false, for: 'mark', reason: 'notes are gone: you can leave the book standing open (open_book)' }), 'a note: notes are gone');
check(same(read({ t: 'mark', address: addr }), { ok: false, for: 'mark', reason: 'kind must be open_book' }), 'a mark of no kind: kind must be open_book');
check(same(read({ t: 'mark', address: { ...addr, shelf: 9 }, kind: 'note' }), { ok: false, for: 'mark', reason: 'bad address' }), 'the address is checked before the kind');
{
  const good = P.claim({ ...addr, page: 1, at: 7, len: 30 });
  const bads = [{ ...good, page: 0 }, { ...good, page: 411 }, { ...good, at: 1.5 }, { ...good, len: 3201 }, { ...good, len: '9' }, { ...good, address: { ...addr, side: 2 } }, null, 'claim'];
  const r = read({ t: 'finds', finds: [good, ...bads] });
  check(r.ok && r.msg.t === 'finds' && r.msg.finds[0].ok && r.msg.finds.slice(1).every(x => !x.ok && x.reason === 'bad claim'), `malformed claims: bad claim, each in its place (${bads.length})`);
  const many = read(P.finds(Array.from({ length: 40 }, () => good)));
  check(many.ok && many.msg.t === 'finds' && many.msg.finds.length === 16, 'only the first 16 claims are read');
  check(same(read({ t: 'finds', finds: 'lots' }), { ok: true, msg: { t: 'finds', finds: [] } }), 'finds that are not a list: nothing claimed');
  check(read({ t: 'finds', finds: [{ ...good, len: 3200 }] }).ok && (read({ t: 'finds', finds: [{ ...good, len: 3200 }] }) as { msg: { finds: Array<{ ok: boolean }> } }).msg.finds[0].ok, 'a claim of a whole page (3200) has the right shape');
}
check(same(read({ t: 'ping', at0: 'x' }), { ok: true, msg: { t: 'ping', at0: undefined } }), 'a ping\'s at0 is echoed only when it is a number');
check(same(P.error('bad address', 'open'), { t: 'error', for: 'open', reason: 'bad address' }) && same(P.error('bad json'), { t: 'error', reason: 'bad json' }), 'errors as the world sends them');

// ---- readers
{
  const board = { top: [], min: 9, sides: [{ name: 'east', min: 9, top: [{ text: 'a' }] }, { name: 'west', min: 14, top: [{ text: 'b' }] }] } as unknown as Parameters<typeof P.boardMin>[0];
  check(P.boardMin(board, 1) === 14 && P.boardMin(board) === 9 && P.boardFinds(board).length === 2 && P.boardFinds(null).length === 0, 'board readers: each side\'s minimum, and every find');
}

// ---- world → client: every builder round-trips through read(), and read() refuses what it can't use
const you = { id: 'p_0123456789abcdef', kind: 'human' as const, name: 'Soren', x: -3.2, y: 4.25, floor: 0, side: 0 as const, yaw: 1.57, state: 'walking' as const, vx: 0, vy: 1.5 };
const agent = { id: 'a_1', kind: 'agent' as const, name: 'Agent', x: -3.2, y: 9, floor: -1, side: 1 as const, yaw: 0, state: 'standing' as const };
const find = { side: 0 as const, floor: 0, unit: 10, shelf: 3, slot: 11, page: 201, at: 3064, len: 12, words: 3, text: 'daub tabs by', finder: 'Soren', agent: 0 as const, foundAt: 1e12 };
const wboard = { top: [find], min: 9, sides: [{ name: 'east', min: 9, top: [find] }, { name: 'west', min: 14, top: [] }] } as P.Board;
const row = { id: 7, night: 3, side: 1 as const, floor: 0, unit: 12, shelf: 2, slot: 5, kind: 'open_book' as const, text: '', author: 'Soren', createdAt: 1e12 };
const entry = { ...agent, present: true, updatedAt: 1e12, farthestY: 40, farthestFloor: -2, farthestAt: null, booksOpened: 3 };
const results: P.FoundResult[] = [{ ok: true, first: true, rank: 2, overall: 3, side: 'east', text: 'daub tabs by', finder: 'Soren', address: { floor: 0, unit: 10, side: 0, shelf: 3, slot: 11 }, page: 201, at: 3064 },
  { ok: false, reason: 'no such find' }];
const worldMsgs: Array<[string, object]> = [
  ['welcome', P.W.welcome({ you, night: 3, nextAt: 2e12, rules: { walk: 1.5, run: 4.2 }, board: wboard })],
  ['correct', P.W.correct({ x: -3.2, y: 4, floor: 0, side: 1, reason: 'too fast' })],
  ['peers', P.W.peers(1e12, [you, agent])],
  ['roster', P.W.roster([entry, { ...entry, id: 'h_2', farthestAt: 5 }])],
  ['board', P.W.board(wboard)],
  ['found', P.W.found(results, wboard)],
  ['marks', P.W.marks([row, { ...row, id: 8, side: 0 }])],
  ['mark', P.W.mark(row)],
  ['marked', P.W.marked(row)],
  ['night', P.W.night(4, 3e12)],
  ['replaced', P.W.replaced()],
  ['rekey', P.W.rekey('0123456789abcdef01234567')],
  ['full', P.W.full(120)],
  ['error', P.W.error('out of reach', 'mark')],
  ['error (no for)', P.W.error('bad json')],
  ['pong', P.W.pong(1e12, 42)],
  ['pong (no at0)', P.W.pong(1e12)],
];
for (const [what, m] of worldMsgs) {
  const r = P.read(P.encode(m));
  check(r.ok && same(r.msg, m), `world → client ${what} round-trips${r.ok ? '' : `: ${r.reason}`}`);
}
{
  const covered = new Set(worldMsgs.map(([, m]) => (m as { t: string }).t));
  check(Object.keys(P.S).every(t => covered.has(t) && typeof (P.W as Record<string, unknown>)[t] === 'function'), 'every world message type has a builder, and a round-trip above');
  check(Object.keys(P.W).every(k => k in P.S || k === 'peersFrame'), 'every world builder is a message type (or the peers fast path)');
  const frame = P.W.peersFrame(1e12, [you, agent].map(p => P.encode(P.person(p)))), joined = P.W.peersFrame(1e12, [you, agent].map(p => JSON.stringify(P.person(p))).join(','));
  check(frame === joined && same(JSON.parse(frame), P.W.peers(1e12, [you, agent])) && same(P.read(frame), { ok: true, msg: P.W.peers(1e12, [you, agent]) }),
    'peersFrame (pre-serialised people, as a list or joined) is the same frame as peers()');
  check(same(P.read(P.W.peersFrame(5, [])), { ok: true, msg: { t: 'peers', at: 5, peers: [] } }), 'an empty peers frame');
  check(P.W.pong(1, 'x') && !('at0' in P.W.pong(1, 'x')), 'pong echoes at0 only when it is a number');
  // the world's own pub() shape (vx/vy only on the move) is a person as is
  const { vx: _vx, vy: _vy, ...still } = you;
  check(same(P.person(still), still) && !('vx' in P.person(still)), 'a person still has no vx/vy');
}
// tolerant of what it doesn't know: extra fields are dropped, not refused; missing optional fields get defaults
{
  const extra = { ...P.W.welcome({ you, night: 3, nextAt: 2e12, rules: { walk: 1.5, run: 4.2 }, board: wboard }), motd: 'hi', you: { ...you, hat: 'tall' } };
  const r = P.read(JSON.stringify(extra));
  check(r.ok && r.msg.t === 'welcome' && !('motd' in r.msg) && !('hat' in r.msg.you) && r.msg.you.name === 'Soren', 'unknown extra fields are tolerated (and dropped), at the top and inside');
  const bare = P.read({ t: 'welcome', you: { id: 'x', x: -3, y: 4, floor: 0 }, night: 1, nextAt: 2, board: { sides: [{ min: 9 }, { min: 14 }] } });
  check(bare.ok && bare.msg.t === 'welcome' && same(bare.msg.you, { id: 'x', kind: 'human', name: '', x: -3, y: 4, floor: 0, side: 0, yaw: 0, state: 'standing' })
    && same(bare.msg.rules, { walk: 1.5, run: 4.2 }) && bare.msg.board.min === 9 && bare.msg.board.sides[1].name === 'west' && bare.msg.board.top.length === 0,
    'missing optional fields get defaults (kind, name, side, yaw, state, rules, board names and lists)');
  check(same(P.read({ t: 'full' }), { ok: true, msg: { t: 'full', retryInS: 120 } }) && same(P.read({ t: 'correct', x: 1, y: 2, floor: 0 }), { ok: true, msg: { t: 'correct', x: 1, y: 2, floor: 0, side: 0, reason: 'too fast' } }),
    'full defaults to 120 s; a correction to east and too fast');
  const peers = P.read({ t: 'peers', at: 1, peers: [you, { id: 'nowhere' }, 'junk', agent] });
  check(peers.ok && peers.msg.t === 'peers' && peers.msg.peers.length === 2, 'a person who can\'t be read is left out of peers, not the whole frame');
}
// malformed frames: refused, with a reason a client can log
for (const [what, raw, why] of [
  ['not JSON', '{nope', /not JSON/], ['not an object', '[1]', /not an object/], ['null', 'null', /not an object/],
  ['an unknown type', { t: 'teleport' }, /unknown message type teleport/], ['no type', { you }, /unknown message type undefined/],
  ['a welcome with no you', { t: 'welcome', night: 1, nextAt: 2, board: wboard }, /welcome: you: not an object/],
  ['a welcome whose you has no position', { t: 'welcome', you: { id: 'x' }, night: 1, nextAt: 2, board: wboard }, /you\.x: not a number/],
  ['a board with one side', { t: 'board', board: { top: [], min: 9, sides: [{ min: 9, top: [] }] } }, /board\.sides: not two sides/],
  ['a board with a find that has no place', { t: 'board', board: { ...wboard, top: [{ text: 'x' }] } }, /board\.top\[0\]\.floor/],
  ['a night that isn\'t a number', { t: 'night', n: '4', nextAt: 1 }, /night: n: not a number/],
  ['marks that aren\'t a list', { t: 'marks', replace: true, marks: {} }, /marks: not a list/],
  ['a mark of another kind', { t: 'mark', mark: { ...row, kind: 'note' } }, /mark\.kind: note/],
  ['a rekey that is no secret', { t: 'rekey', anon: 'short' }, /anon: not a secret/],
  ['an error with no reason', { t: 'error', for: 'open' }, /reason: not a string/],
  ['found with no results', { t: 'found', board: wboard }, /results: not a list/],
  ['a found result with a bad address', { t: 'found', results: [{ ...results[0], address: { floor: 0 } }], board: wboard }, /results\[0\]\.address/],
  ['a pong with no time', { t: 'pong', at0: 1 }, /at: not a number/],
] as Array<[string, unknown, RegExp]>) {
  const r = P.read(typeof raw === 'string' ? raw : JSON.stringify(raw));
  check(!r.ok && why.test(r.reason), `malformed: ${what} is refused${r.ok ? '' : ` (${r.reason})`}`);
}

// ---- the world sends only what has a builder: every t: literal or builder named in src/*.ts (read as text, so this
// holds while world.ts is being split up)
{
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => ({ f, text: readFileSync(new URL(f, dir), 'utf8') }));
  const world = files.map(x => x.text).join('\n'), proto = readFileSync(new URL('../web/protocol.js', import.meta.url), 'utf8');
  const literals = new Set<string>(), builders = new Set<string>();
  for (const { f, text } of files) {
    for (const m of text.matchAll(/\{\s*"?t"?\s*:\s*['"`]([a-z_-]+)['"`]/g)) literals.add(`${m[1]} (${f})`);
    if (!/protocol\.js['"]/.test(text)) continue;
    for (const m of text.matchAll(/\b(?:Proto\.)?W\.([A-Za-z]+)\b/g)) builders.add(m[1]);
  }
  const noBuilder = [...literals].filter(l => !(l.split(' ')[0] in P.S));
  check(noBuilder.length === 0, `every message literal in src/*.ts is a world message type with a builder${literals.size ? ` (still by hand: ${[...literals].sort().join(', ')})` : ''}${noBuilder.length ? `; NO BUILDER: ${noBuilder}` : ''}`);
  const unknown = [...builders].filter(b => typeof (P.W as Record<string, unknown>)[b] !== 'function');
  check(unknown.length === 0, `every builder src/*.ts uses exists (${[...builders].sort().join(', ') || 'none yet'})${unknown.length ? `; missing ${unknown}` : ''}`);
  check(Object.keys(P.S).every(t => proto.includes(`t: '${t}'`)), 'every world message type is documented in protocol.js');
  const cases = [...world.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]).filter(t => !['note', 'open_book'].includes(t));
  const handled = new Set(['hello', ...cases.filter(t => t in P.C)]);
  check(Object.keys(P.C).every(t => handled.has(t)), `every client message type is one the world reads (${Object.keys(P.C).join(', ')})`);
}

// ---- the page and the session: messages built with protocol.js, every frame read with it
{
  const html = readFileSync(new URL('../web/short-stay-library.html', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  check(/import \* as Proto from '\.\/protocol\.js'/.test(html) && !/send\(\{ t:/.test(html) && !/ws\.send\(JSON\.stringify\(\{/.test(html), 'the page builds its messages with protocol.js');
  check(/Proto\.read\(/.test(session) && !/JSON\.parse/.test(session), 'session.js reads every frame with Proto.read');
  check(!/kind === 'note'/.test(html) && !/ribbon/i.test(html), 'the page has no note marks left');
}

{
  // whether a fall has crossed already (once a fall) travels on corrections and your welcome; moves don't carry it
  const mv = P.validate(JSON.parse(P.encode(P.move({ x: 15.1, y: 39.9, floor: -5, yaw: 0, side: 1 }))));
  check(mv.ok && !('crossed' in (mv as any).msg), 'a move says nothing of crossings (the world keeps count)');
  const c = P.read(P.encode(P.W.correct({ x: 15, y: 30, floor: -5, side: 1, reason: 'too fast', crossed: true })));
  check(c.ok && (c as any).msg.crossed === true, 'a correction carries the world\'s crossed');
  const c0 = P.read(P.encode(P.W.correct({ x: -3, y: 4, floor: 0, side: 0, reason: 'night' })));
  check(c0.ok && !(c0 as any).msg.crossed, 'and not when not');
  const w = P.read(P.encode(P.W.welcome({ you: { id: 'p_0123456789abcdef', kind: 'human', name: 'S', x: 15, y: 30, floor: -5, side: 1, yaw: 0, state: 'falling', crossed: true }, night: 1, nextAt: 2, rules: { walk: 1.5, run: 4.2 }, board: { top: [], min: 9, sides: [{ name: 'east', min: 9, top: [] }, { name: 'west', min: 9, top: [] }] } })));
  check(w.ok && (w as any).msg.you.crossed === true, 'and so does your welcome, mid-fall');
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
