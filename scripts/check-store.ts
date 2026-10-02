// Checks src/store.ts, the world's SQLite file, with no server: a new world and worlds left by the old migrate() are
// brought to the current schema once (and a second wake does no migration work), the boards held in memory agree with
// the old queries claim by claim, and each operation stays within a budget of rows on a seeded world (20k events, 2k
// players). Run: node scripts/check-store.ts
//
// What is measured here. Node's node:sqlite reports no rows read, so the adapter below estimates them: the rows a
// statement returns, or, if more, the whole size of the tables its query plan (EXPLAIN QUERY PLAN) SCANs. Index searches count
// only what they return, so the figures understate an index range walk (e.g. a COUNT over an index) but never hide
// a full scan: every budget below also asserts its plans have no SCAN of a world table. Rows written are SQLite's
// changes() (table rows, not index entries); Cloudflare's own counts (cursor.rowsRead/rowsWritten, which the store
// uses in production) also count index entries, so production figures run somewhat higher.
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA } from '../src/store.ts';
import { nodeSql, type Logged } from './node-store.ts';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const LIB = 'sides-1', T = Date.UTC(2026, 9, 2, 12);   // a fixed now, mid-day UTC
const WORLD_TABLES = new Set(['players', 'marks', 'events', 'finds', 'agent_keys', 'meta']);

// ------------------------------------------------------------------ the node:sqlite adapter at the store's seam (scripts/node-store.ts)
const open = (db: DatabaseSync, o: Partial<{ library: string; now: () => number; keep: number }> = {}) => {
  const sql = nodeSql(db), store = new Store(sql, { library: o.library ?? LIB, now: o.now ?? (() => T), keep: o.keep });
  return { sql, store };
};
const since = (log: Logged[], from: number) => log.slice(from);
const worldScans = (l: Logged[]) => l.flatMap(x => x.scans.filter(t => WORLD_TABLES.has(t)).map(t => `${t} in: ${x.q.slice(0, 90)}`));
const all = (db: DatabaseSync, q: string, ...b: (string | number | null)[]) => db.prepare(q).all(...b) as Record<string, any>[];
const get = (db: DatabaseSync, q: string, ...b: (string | number | null)[]) => db.prepare(q).get(...b) as Record<string, any>;
const indexes = (db: DatabaseSync, t: string) => new Set(all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", t).map(r => r.name as string));

// ------------------------------------------------------------------ worlds as the old migrate() left them
// What the old migrate() leaves on a world from launch day: every column, the identity indexes, finds with sides,
// meta with the library and usage but no schema. Extra rows simulate what the old code's every-wake steps cleaned.
function oldWorld(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE players (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, floor INTEGER NOT NULL, yaw REAL NOT NULL, updated_at INTEGER NOT NULL,
      farthest_y REAL NOT NULL DEFAULT 0, farthest_floor INTEGER NOT NULL DEFAULT 0, farthest_at INTEGER,
      books_opened INTEGER NOT NULL DEFAULT 0, connected INTEGER NOT NULL DEFAULT 0,
      fall_t0 INTEGER, fall_floor INTEGER, side INTEGER NOT NULL DEFAULT 0, pub_id TEXT, secret_hash TEXT, name_locked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE marks (id INTEGER PRIMARY KEY AUTOINCREMENT, night INTEGER NOT NULL,
      floor INTEGER NOT NULL, unit INTEGER NOT NULL, shelf INTEGER NOT NULL, slot INTEGER NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL, created_at INTEGER NOT NULL, side INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX marks_place ON marks(night, floor, unit);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, author TEXT, type TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE agent_keys (key_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL, name TEXT NOT NULL, rate_per_min INTEGER NOT NULL,
      created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE finds (side INTEGER NOT NULL, floor INTEGER NOT NULL, unit INTEGER NOT NULL, shelf INTEGER NOT NULL, slot INTEGER NOT NULL,
      page INTEGER NOT NULL, at INTEGER NOT NULL, len INTEGER NOT NULL, words INTEGER NOT NULL, text TEXT NOT NULL,
      finder TEXT NOT NULL, finder_name TEXT NOT NULL, found_at INTEGER NOT NULL, PRIMARY KEY (side, floor, unit, shelf, slot, page, at));
    CREATE INDEX finds_by_len ON finds(len DESC, found_at);
    CREATE INDEX finds_side_len ON finds(side, len DESC, found_at);
    CREATE UNIQUE INDEX players_pub ON players(pub_id);
    CREATE UNIQUE INDEX players_secret ON players(secret_hash) WHERE secret_hash IS NOT NULL;`);
  db.prepare("INSERT INTO meta VALUES ('library', ?)").run(LIB);
}
const P_COLS = 'id, kind, name, x, y, floor, yaw, updated_at';
function addPlayer(db: DatabaseSync, id: string, kind = 'human', extra: Record<string, string | number | null> = {}) {
  const k = Object.keys(extra);
  db.prepare(`INSERT INTO players (${P_COLS}${k.map(c => ', ' + c).join('')}) VALUES (?,?,?,0,1,0,0,?${k.map(() => ',?').join('')})`).run(id, kind, 'n ' + id, T, ...Object.values(extra));
}

console.log('A new world');
{
  const db = new DatabaseSync(':memory:'), { store } = open(db);
  check(store.migrated.from === 0 && store.migrated.to === SCHEMA, `migrates from nothing to version ${SCHEMA} (${JSON.stringify(store.migrated)})`);
  check(get(db, "SELECT value FROM meta WHERE key = 'schema'")?.value === String(SCHEMA), 'the version is kept in meta');
  check(get(db, "SELECT value FROM meta WHERE key = 'library'")?.value === LIB, 'and the library version');
  const ev = all(db, 'SELECT type, payload FROM events');
  check(ev.length === 1 && ev[0].type === 'library' && JSON.parse(ev[0].payload).from === null, "as before, a new world's log opens with its library");
  for (const [t, ix] of [['finds', ['finds_by_len', 'finds_side_len', 'finds_finder']], ['events', ['events_type_at', 'events_h_author']], ['players', ['players_pub', 'players_secret', 'players_name']]] as const)
    check(ix.every(i => indexes(db, t).has(i)), `${t} has ${ix.join(', ')}`);
}

console.log('\nA world left by the old migrate() (launch day: every column, no schema version)');
{
  const db = new DatabaseSync(':memory:'); oldWorld(db);
  addPlayer(db, 'h_secret1', 'human', { pub_id: 'p_aaaa', secret_hash: null });   // pub_id given, events not yet rewritten
  addPlayer(db, 'h_new', 'human', { pub_id: 'p_bbbb', secret_hash: 'hash' });
  addPlayer(db, 'a_agent', 'agent', { pub_id: 'a_agent' });
  db.exec(`INSERT INTO events (at, author, type, payload) VALUES (1, 'h_secret1', 'arrive', '{"name":"x"}'), (2, 'a_agent', 'arrive', '{}'), (3, NULL, 'night', '{}'), (4, 'h_gone', 'mark', '{}');
    INSERT INTO marks (night, floor, unit, shelf, slot, kind, text, author, author_name, created_at, side) VALUES (1,0,1,0,0,'note','hi','h_new','n',1,0), (1,0,1,0,1,'open_book','','h_new','n',1,0);
    INSERT INTO finds VALUES (0,0,1,0,0,1,5,12,2,'some text he','p_bbbb','n',10), (1,0,1,0,0,1,5,11,2,'other texts','a_agent','n',11);`);
  // the old code's bug: an archive renamed with ALTER TABLE kept finds_finder's name (here: an index name it will want)
  db.exec('CREATE TABLE finds_original (x); CREATE INDEX finds_finder ON finds_original(x);');
  db.prepare("INSERT INTO meta VALUES ('usage', ?)").run(JSON.stringify({ day: '2026-10-02', requests: 7, wsIn: 3, rowsRead: 1000, rowsWritten: 50 }));
  const { store, sql } = open(db);
  check(store.migrated.from === 0 && store.migrated.steps.join() === '1,2,3,4', `migrated through steps 1 to 4 (${store.migrated.steps})`);
  check(all(db, "SELECT kind FROM marks").map(r => r.kind).join() === 'open_book', 'notes are gone, the open book stays');
  const authors = all(db, 'SELECT author FROM events ORDER BY id').map(r => r.author);
  check(authors.join() === 'p_aaaa,a_agent,,h_gone', `old 'h_' authors are rewritten to public ids; agents and unknown authors untouched (${authors.join()})`);
  check(get(db, 'SELECT COUNT(*) AS n FROM finds').n === 2 && !all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'finds\\_%' ESCAPE '\\' AND name <> 'finds_original'").length, 'finds with sides at the same library are kept where they are');
  check(all(db, "SELECT type FROM events WHERE type = 'library'").length === 0, 'no library event when the library has not changed');
  check(indexes(db, 'finds').has('finds_finder') && !indexes(db, 'finds_original').has('finds_finder'), 'an index name an archive had taken is given back to finds');
  check(sql.log.some(l => /DELETE FROM marks WHERE kind = 'note'/.test(l.q)) && sql.log.some(l => /UPDATE events SET author/.test(l.q)), 'the note delete and the identity rewrite ran');
  // they run once: what they would clean is left alone on the next wake
  db.exec(`INSERT INTO marks (night, floor, unit, shelf, slot, kind, text, author, author_name, created_at, side) VALUES (1,0,1,0,2,'note','','x','x',1,0);
    INSERT INTO events (at, author, type, payload) VALUES (5, 'h_secret1', 'probe', '{}');`);
  const again = open(db);
  check(again.store.migrated.steps.length === 0 && again.store.migrated.from === SCHEMA, 'the second wake migrates nothing');
  check(!again.sql.log.some(l => /kind = 'note'|UPDATE events|pragma_table_info|sqlite_master/.test(l.q)), 'and neither deletes notes, rewrites the log, nor reads the schema');
  check(again.sql.log.length === 1 && worldScans(again.sql.log).length === 0 && again.sql.log[0].returned <= 3,
    `a wake at the current version is one query of at most three meta rows, no scans (${again.sql.log.map(l => `${l.q.slice(0, 60)}: ${l.plan.join('; ')}`).join(' | ')})`);
  check(all(db, "SELECT 1 FROM marks WHERE kind = 'note'").length === 1 && all(db, "SELECT 1 FROM events WHERE author = 'h_secret1'").length === 1, 'so a note or an h_ author written since stays (proof the steps did not run again)');
  // usage: the saved figures, plus every row this wake read
  const u = store.usage(), costs = Object.values(store.costsSinceWake()), read = costs.reduce((n, c) => n + c.rowsRead, 0);
  check(u.requests === 7 && u.wsIn === 3 && u.rowsRead === 1000 + read && read > 0, `usage continues today's saved figures and includes the wake's own reads (${u.rowsRead} = 1000 + ${read})`);
  store.count('requests');
  const u2 = store.usage();
  check(u2.requests === 8 && u2.rowsRead >= u.rowsRead, 'the first request of the wake adds to them instead of replacing them');
  check(JSON.parse(get(db, "SELECT value FROM meta WHERE key = 'usage'").value).requests === 8, 'and is saved');
  const savedNow = JSON.parse(get(db, "SELECT value FROM meta WHERE key = 'usage'").value), third = open(db).store, w = third.usage();
  check(w.requests === 8 && w.rowsRead === savedNow.rowsRead + third.costsSinceWake().wake.rowsRead, `a later wake starts from the saved figures plus its own reads (${w.rowsRead})`);
}

console.log('\nA world from before the sides and the public ids');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE players (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, floor INTEGER NOT NULL, yaw REAL NOT NULL, updated_at INTEGER NOT NULL,
      farthest_y REAL NOT NULL DEFAULT 0, farthest_floor INTEGER NOT NULL DEFAULT 0, farthest_at INTEGER,
      books_opened INTEGER NOT NULL DEFAULT 0, connected INTEGER NOT NULL DEFAULT 0, fall_t0 INTEGER, fall_floor INTEGER);
    CREATE TABLE marks (id INTEGER PRIMARY KEY AUTOINCREMENT, night INTEGER NOT NULL,
      floor INTEGER NOT NULL, unit INTEGER NOT NULL, shelf INTEGER NOT NULL, slot INTEGER NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, author TEXT, type TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE finds (floor INTEGER NOT NULL, unit INTEGER NOT NULL, shelf INTEGER NOT NULL, slot INTEGER NOT NULL,
      page INTEGER NOT NULL, at INTEGER NOT NULL, len INTEGER NOT NULL, words INTEGER NOT NULL, text TEXT NOT NULL,
      finder TEXT NOT NULL, finder_name TEXT NOT NULL, found_at INTEGER NOT NULL, PRIMARY KEY (floor, unit, shelf, slot, page, at));
    CREATE INDEX finds_by_len ON finds(len DESC, found_at);`);
  db.prepare("INSERT INTO meta VALUES ('library', ?)").run(LIB);
  for (const id of ['h_one', 'h_two', 'a_bot']) db.prepare(`INSERT INTO players (${P_COLS}) VALUES (?,?,?,0,1,0,0,?)`).run(id, id[0] === 'a' ? 'agent' : 'human', id, T);
  db.exec(`INSERT INTO events (at, author, type, payload) VALUES (1, 'h_one', 'arrive', '{}'), (2, 'h_two', 'rename', '{}'), (3, 'a_bot', 'arrive', '{}');
    INSERT INTO marks (night, floor, unit, shelf, slot, kind, text, author, author_name, created_at) VALUES (1,0,1,0,0,'note','x','h_one','h',1);
    INSERT INTO finds VALUES (0,1,0,0,1,5,12,2,'some text he','h_one','h',10);`);
  const { store } = open(db);
  check(store.migrated.steps.join() === '1,2,3,4', 'migrated through steps 1 to 4');
  const ps = all(db, 'SELECT id, pub_id, side, secret_hash, name_locked FROM players ORDER BY id');
  check(ps.every(p => p.side === 0 && p.secret_hash === null && p.name_locked === 0), 'players get side 0, no secret hash, unlocked names');
  check(ps.find(p => p.id === 'a_bot')!.pub_id === 'a_bot' && ps.filter(p => p.id.startsWith('h_')).every(p => /^p_[0-9a-f]{16}$/.test(p.pub_id)), "agents keep their id as their public id; humans get a random 'p_' one");
  const byId = Object.fromEntries(ps.map(p => [p.id, p.pub_id]));
  check(all(db, 'SELECT author FROM events WHERE type <> \'library\' ORDER BY id').map(r => r.author).join() === [byId.h_one, byId.h_two, 'a_bot'].join(), 'the log names them by their public ids');
  check(get(db, 'SELECT COUNT(*) AS n FROM finds_before_sides').n === 1 && get(db, 'SELECT COUNT(*) AS n FROM finds').n === 0, 'finds from before the sides are put aside in finds_before_sides; the board starts empty');
  check(['finds_by_len', 'finds_side_len', 'finds_finder'].every(i => indexes(db, 'finds').has(i)), 'and the new finds table has its indexes (the renamed one did not keep their names)');
  const lib = all(db, "SELECT payload FROM events WHERE type = 'library'").map(r => JSON.parse(r.payload));
  check(lib.length === 1 && lib[0].findsKeptAside === 1 && lib[0].table === 'finds_before_sides' && lib[0].from === LIB, 'the log says so, as before');
  check(get(db, 'SELECT COUNT(*) AS n FROM marks').n === 0, 'and the marks go with the old text');
  // a later library: archived again, once, without a schema migration
  const next = open(db, { library: 'sides-2' });
  check(next.store.migrated.steps.join() === 'library' && get(db, 'SELECT COUNT(*) AS n FROM finds_sides_1').n === 0 && get(db, "SELECT value FROM meta WHERE key = 'library'").value === 'sides-2',
    'a new library version puts the board aside (finds_sides_1) on the wake that sees it');
  check(open(db, { library: 'sides-2' }).store.migrated.steps.length === 0, 'and only then');
}

console.log('\nThe boards, against the old queries, claim by claim');
{
  // The same claims go to the store and, on a second database, through the old world's SQL (boardMin by OFFSET,
  // ranks by COUNT, the trim by NOT IN); every result and every board must be the same.
  const KEEP = 30, MIN = 9;
  const db = new DatabaseSync(':memory:'), { store } = open(db, { keep: KEEP });
  const ref = new DatabaseSync(':memory:'); ref.exec(`CREATE TABLE finds (side INTEGER NOT NULL, floor INTEGER NOT NULL, unit INTEGER NOT NULL, shelf INTEGER NOT NULL, slot INTEGER NOT NULL,
      page INTEGER NOT NULL, at INTEGER NOT NULL, len INTEGER NOT NULL, words INTEGER NOT NULL, text TEXT NOT NULL,
      finder TEXT NOT NULL, finder_name TEXT NOT NULL, found_at INTEGER NOT NULL, PRIMARY KEY (side, floor, unit, shelf, slot, page, at));
    CREATE INDEX finds_by_len ON finds(len DESC, found_at); CREATE INDEX finds_side_len ON finds(side, len DESC, found_at);`);
  const cols = `side, floor, unit, shelf, slot, page, at, len, words, text, finder_name AS finder, substr(finder, 1, 2) = 'a_' AS agent, found_at AS foundAt`;
  const refMin = (sd: number) => { const r = get(ref, 'SELECT len FROM finds WHERE side = ? ORDER BY len DESC, found_at LIMIT 1 OFFSET ?', sd, KEEP - 1); return r ? r.len + 1 : MIN; };
  const refBoard = (limit: number) => ({ top: all(ref, `SELECT ${cols} FROM finds ORDER BY len DESC, found_at LIMIT ?`, limit),
    sides: [0, 1].map(sd => all(ref, `SELECT ${cols} FROM finds WHERE side = ? ORDER BY len DESC, found_at LIMIT ?`, sd, limit)), mins: [refMin(0), refMin(1)] });
  const plain = (x: unknown) => JSON.stringify(x);
  let seed = 7; const rnd = (n: number) => {   // mulberry32: repeatable
    seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  let mismatches = 0, results = 0, firsts = 0;
  const places: { side: number; floor: number; unit: number; shelf: number; slot: number; page: number; at: number; len: number }[] = [];
  for (let msg = 0; msg < 400; msg++) {
    const now = T + msg * 1000 - (msg % 7 === 0 ? 1000 : 0);   // some messages share a found_at with the one before
    const finder = rnd(5) === 0 ? 'a_bot' : 'p_' + rnd(4), name = 'name ' + finder;
    const mins = store.boardMins(), rmins = [refMin(0), refMin(1)];
    if (plain(mins) !== plain(rmins)) mismatches++;
    let changed = false;
    for (let k = 0, n = 1 + rnd(4); k < n; k++) {
      const again = places.length && rnd(4) === 0;
      const f = again ? places[rnd(places.length)] : { side: rnd(2), floor: rnd(3), unit: rnd(5), shelf: rnd(6), slot: rnd(32), page: 1 + rnd(3), at: rnd(3000), len: MIN + rnd(10) };
      if (f.len < mins[f.side]) continue;   // judgeClaim's rule: the find must reach the side's minimum
      if (!again) places.push(f);
      const known = store.known(f), fx = { ...f, len: known?.len ?? f.len, words: 2, text: 'x'.repeat(known?.len ?? f.len) };
      const got = store.claim(fx, finder, name, now);
      const r = ref.prepare(`INSERT INTO finds VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(f.side, f.floor, f.unit, f.shelf, f.slot, f.page, f.at, fx.len, 2, fx.text, finder, name, now);
      const row = get(ref, 'SELECT finder_name, found_at FROM finds WHERE side=? AND floor=? AND unit=? AND shelf=? AND slot=? AND page=? AND at=?', f.side, f.floor, f.unit, f.shelf, f.slot, f.page, f.at);
      const ahead = (onSide: boolean) => (get(ref, `SELECT COUNT(*) AS n FROM finds WHERE (len > ? OR (len = ? AND found_at < ?))${onSide ? ' AND side = ?' : ''}`, fx.len, fx.len, row.found_at, ...(onSide ? [f.side] : [])).n as number) + 1;
      const want = { first: Number(r.changes) > 0, finder: row.finder_name, foundAt: row.found_at, rank: ahead(true), overall: ahead(false) };
      results++; if (want.first) { firsts++; changed = true; }
      if (plain(got) !== plain(want)) { mismatches++; if (mismatches < 4) console.log('     ', plain(got), '!=', plain(want)); }
    }
    if (changed) {
      store.trimBoard();
      for (const sd of [0, 1]) ref.prepare('DELETE FROM finds WHERE side = ? AND rowid NOT IN (SELECT rowid FROM finds WHERE side = ? ORDER BY len DESC, found_at LIMIT ?)').run(sd, sd, KEEP);
    }
    for (const limit of [10, KEEP]) {
      const b = store.board(limit), w = refBoard(limit);
      if (plain(b.top) !== plain(w.top) || plain(b.sides) !== plain(w.sides) || plain(b.mins) !== plain(w.mins)) { mismatches++; if (mismatches < 4) console.log('      board differs at message', msg); }
    }
  }
  check(firsts > 2 * KEEP && results > firsts, `${results} claims (${firsts} new) in 400 messages, boards of ${KEEP} a side, ties in length and in time`);
  check(mismatches === 0, `every claim's result, every minimum and every board equal the old queries' (${mismatches} differences)`);
  check([0, 1].every(sd => get(db, 'SELECT COUNT(*) AS n FROM finds WHERE side = ?', sd).n === KEEP), 'the table holds exactly a full board a side');
  const reopened = open(db, { keep: KEEP }).store;
  check(plain(reopened.board(KEEP)) === plain(store.board(KEEP)), 'a new wake reads back the same boards');
  // renames and removals reach the held boards
  store.renamePlayer('a_bot', 'Bot Renamed');
  check(store.board(KEEP).top.filter(r => r.agent).every(r => r.finder === 'Bot Renamed') && all(db, "SELECT DISTINCT finder_name FROM finds WHERE finder = 'a_bot'").map(r => r.finder_name).join() === 'Bot Renamed', 'a rename shows on the board and in the table');
  const had = all(db, "SELECT 1 FROM finds WHERE finder = 'p_1'").length, gone = store.removePlayer('p_1');
  check(gone === had && store.board(KEEP).top.every(r => r.finder !== 'name p_1') && plain(open(db, { keep: KEEP }).store.board(KEEP)) === plain(store.board(KEEP)), `removing a player takes their ${had} finds off the board and the table alike`);
  store.clearFinds();
  check(store.board(KEEP).top.length === 0 && plain(store.boardMins()) === plain([MIN, MIN]), 'cleared, the boards are empty and the minimum is the minimum');
}

console.log('\nRows per operation on a seeded world (20k events, 2k players, full boards)');
{
  const db = new DatabaseSync(':memory:'); open(db);   // a current world
  db.exec('BEGIN');
  const ins = db.prepare(`INSERT INTO players (${P_COLS}, pub_id, secret_hash) VALUES (?,?,?,0,1,0,0,?,?,?)`);
  for (let i = 0; i < 2000; i++) ins.run(`h_${i}`, i % 50 ? 'human' : 'agent', `name ${i}`, T, `p_${i}`, i % 50 ? `hash${i}` : null);
  const key = db.prepare('INSERT INTO agent_keys (key_hash, player_id, name, rate_per_min, created_at) VALUES (?,?,?,60,?)');
  for (let i = 0; i < 2000; i += 50) key.run(`key${i}`, `h_${i}`, `name ${i}`, T);   // the 40 agents' keys
  const ev = db.prepare('INSERT INTO events (at, author, type, payload) VALUES (?,?,?,?)');
  for (let i = 0; i < 20000; i++) ev.run(T - 20000_000 + i * 1000, `p_${i % 2000}`, ['move', 'mark', 'find', 'arrive', 'rename'][i % 5], i % 5 === 4 ? '{"to":"x"}' : '{"name":"y"}');
  const fi = db.prepare('INSERT INTO finds VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 400; i++) fi.run(i % 2, 0, i, 0, 0, 1, 0, 9 + (i % 40), 2, 'x', `h_${i % 2000}`, 'n', T - i);
  db.exec('COMMIT');
  const { store, sql } = open(db);
  const measure = (what: string, fn: () => Logged[] | void, budget: number, allowScans: string[] = []) => {
    const from = sql.log.length, own = fn(), l = own ?? since(sql.log, from);
    const read = l.reduce((n, x) => n + x.estRead, 0), written = l.reduce((n, x) => n + x.written, 0);
    const scans = worldScans(l).filter(s => !allowScans.some(a => s.startsWith(a + ' ')));
    check(read <= budget && scans.length === 0, `${what}: ${l.length} queries, ~${read} rows read (budget ${budget}), ${written} written${scans.length ? '; SCANS ' + scans.join(' / ') : ', no scans'}`);
    return l;
  };
  measure('a second wake', () => open(db).sql.log, 3);
  // The wake reads who is here, not everyone: the players of the open sockets by id, and the recently active agents
  // (by way of the agent keys: one row a key). Here: 5 sockets' players, and 40 agents all seeded as just seen.
  measure('the wake\'s players: 5 by id, and agents seen in the last 10 minutes', () => {
    const got = store.playersById(['h_1', 'h_2', 'h_3', 'h_4', 'h_7']), agents = store.agentsSeenSince(T - 600_000);
    check(got.length === 5 && agents.length === 40 && store.agentsSeenSince(T).length === 0, `  found the 5 and the 40 agents, and no agent seen after (${got.length}, ${agents.length})`);
  }, 5 + 2 * (40 + 40), ['agent_keys']);
  measure('a player by id, by secret, by public id', () => {
    check(store.playerById('h_9')?.pubId === 'p_9' && store.playerBySecret('hash9')?.id === 'h_9' && store.playerByPub('p_9')?.id === 'h_9'
      && store.playerBySecret('nobody') === null, '  each finds them, and no one for an unknown secret');
  }, 3);
  measure('is a name taken', () => { check(store.nameTaken('name 5') && !store.nameTaken('Patient Scribe'), '  a name in use is, a new one is not'); }, 1);
  measure("the roster (whole-table: once a wake, when a map asks)", () => { check(store.recentPlayers(T - 30 * 86400_000, 500).length === 500, '  500 of them'); }, 2000, ['players']);
  measure('who is in the shaft (whole-table: once a night)', () => { store.inShaft(); }, 2000, ['players']);
  // a save leaves name and secret alone: renamePlayer and setSecret change them
  store.savePlayer({ ...store.playerById('h_9')!, name: 'ignored', secretHash: 'ignored', x: -1 });
  check(store.playerById('h_9')!.name === 'name 9' && store.playerBySecret('hash9')?.x === -1, 'saving a player changes neither their name nor their secret');
  // a fall's one crossing is kept with the player, so a world that sleeps mid-fall still knows it (once a fall)
  store.savePlayer({ ...store.playerById('h_9')!, x: 14, crossed: true });
  const kept = store.playerById('h_9')!.crossed;
  store.savePlayer({ ...store.playerById('h_9')!, x: -1, crossed: false });
  check(kept === true && store.playerById('h_9')!.crossed === false, 'whether a fall has crossed is saved and read back');
  store.renamePlayer('h_9', 'Nine'); store.setSecret('h_9', 'hash9b');
  check(store.playerById('h_9')!.name === 'Nine' && store.playerBySecret('hash9b')?.id === 'h_9' && !store.playerBySecret('hash9'), 'renamePlayer and setSecret do');
  measure('the first board of the wake (both boards read once)', () => { store.board(50); }, 2 * 201);
  measure('every board after that', () => { store.board(50); store.board(200); store.boardMins(); }, 0);
  measure('a message of 16 claims, ranks and the trim', () => {
    store.boardMins();
    for (let k = 0; k < 16; k++) store.claim({ side: k % 2, floor: 1, unit: k, shelf: 0, slot: 0, page: 1, at: 0, len: 60 + k, words: 2, text: 'x' }, 'h_1', 'n', T);
    store.trimBoard();
  }, 40);
  measure('the same claims again (all known)', () => { for (let k = 0; k < 16; k++) store.claim({ side: k % 2, floor: 1, unit: k, shelf: 0, slot: 0, page: 1, at: 0, len: 60 + k, words: 2, text: 'x' }, 'h_2', 'n', T); }, 16);
  const before = since(sql.log, 0).length;
  const d = store.diag(T - 60_000);
  const dl = since(sql.log, before), dread = dl.reduce((n, x) => n + x.estRead, 0);
  check(worldScans(dl).length === 0 && dread <= 200, `diag over the last minute: ~${dread} rows, no scans (${worldScans(dl).join(' / ') || 'plans: ' + dl.map(x => x.plan.join(', ')).join(' | ')})`);
  check(d.events.n === 20001 && d.events.hAuthor === 0 && d.players.noPub === 0 && d.players.hPub === 0, `its figures are right (events ${d.events.n}, hAuthor ${d.events.hAuthor})`);
  db.exec("INSERT INTO events (at, author, type, payload) VALUES (1, 'h_left', 'x', '{}'); UPDATE players SET pub_id = 'h_old' WHERE id = 'h_5'");
  const d2 = store.diag(T);
  check(d2.events.n === 20002 && d2.events.hAuthor === 1 && d2.players.hPub === 1, "and it sees an 'h_' author or public id left over");
  const wide = store.diag(0);
  check(wide.names.length === 500 && wide.names.every(n => n.type === 'arrive' || n.type === 'rename'), 'names since the start: the first 500 arrivals and renames');
  measure('appending an event', () => { store.appendEvent('p_1', 'mark', {}); }, 0);
  measure('the marks near someone', () => { store.marksNear(1, 0, 0, 10, 2, 140); }, 10);
  measure('a page of the event log', () => { store.eventsSince(19000, 100); }, 100);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
