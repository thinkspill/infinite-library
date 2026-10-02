// The world's SQLite file: its schema, its migrations, and every query the world makes, each a named operation whose
// rows read and written are counted from the first query on (Cloudflare bills them: the Free plan allows 5M rows read
// and 100k written a day). World (src/world.ts) talks to SQLite only through this module.
//
// The seam is Sql, the little of SQLite this needs: ctx.storage.sql satisfies it in production, and
// scripts/check-store.ts adapts Node's node:sqlite to it. Nothing here depends on the Workers runtime.
//
// Costs, per operation, once the world is at the current schema:
//   waking            one read of three meta rows (no migration work, no scans); then the world reads only who is here
//                     (src/population.ts): the players its open sockets belong to, by id, and the agents active in the
//                     last few minutes (agentsSeenSince: the agent keys, a handful, and their players by id)
//   players           everyone else is fetched when needed, one row by an index: by id, by secret hash (logging in), by
//                     public id (moderation), by name (is a random name taken?). Writing a player leaves its name and
//                     secret out of the update (renamePlayer and setSecret change those), so their indexes are touched
//                     only when they change
//   roster, night     whole-table reads, at most once a wake: the map's roster (held by the world afterwards), and at
//                     night the players in the shaft; the owner's reset, wipe and player counts are whole-table too
//   board, claim      the two boards (BOARD_KEEP finds a side) are read once per wake and then held in memory; a claim
//                     writes its row and reads nothing; the trim deletes the ones that fell off by rowid
//   diag              index searches only: events by (type, at), finds by finder, players by pub_id; no full scans

export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;
export interface Cursor<T extends Row = Row> extends Iterable<T> {
  toArray(): T[]; one(): T;
  readonly rowsRead: number; readonly rowsWritten: number;   // final once the cursor is consumed
}
export interface Sql { exec<T extends Row = Row>(query: string, ...bindings: SqlValue[]): Cursor<T> }

// The schema version kept in meta ('schema'). A world without one is from before this module (version 0), whatever
// columns it has. Each step brings a world from the version before it; every step is idempotent, and the version is
// written only after the last, so an interrupted migration simply runs again.
//   1  everything the world's old migrate() did on every wake: the tables, notes gone, the side columns, public ids
//      and secret hashes (and the one-time rewrite of old 'h_' authors in the event log), the finds table with sides
//   2  indexes for the owner's diag and for moderation: events(type, at), events(author) for 'h_' authors only,
//      finds(finder); and the finds indexes repaired if an older library's archive took their names
//   3  players(name), so a new random name is checked against everyone there has been without holding them all
export const SCHEMA = 4;

export type Kind = 'human' | 'agent';
export interface PlayerRecord {
  id: string; kind: Kind; name: string; pubId: string; secretHash: string | null; nameLocked?: boolean;
  x: number; y: number; floor: number; yaw: number; side: number; updatedAt: number;
  farthestY: number; farthestFloor: number; farthestAt: number | null; booksOpened: number; connected: boolean;
  fall: { t0: number; floor: number } | null;
  crossed?: boolean;                                 // humans mid-fall: already crossed the shaft this fall
}
export interface Mark {
  id: number; night: number; side: number; floor: number; unit: number; shelf: number; slot: number;
  kind: string; text: string; author: string; createdAt: number;
}
export interface Place { side: number; floor: number; unit: number; shelf: number; slot: number; page: number; at: number }
export interface FindText { len: number; words: number; text: string }
// One line of a board, in the order of the columns the board has always had (clients see this JSON).
export type BoardRow = { side: number; floor: number; unit: number; shelf: number; slot: number; page: number; at: number;
  len: number; words: number; text: string; finder: string; agent: number; foundAt: number };
export interface Board { top: BoardRow[]; sides: [BoardRow[], BoardRow[]]; mins: [number, number] }
export interface Claimed { first: boolean; finder: string; foundAt: number; rank: number; overall: number }
export interface Usage { day: string; requests: number; wsIn: number; rowsRead: number; rowsWritten: number }
export interface OpCost { calls: number; rowsRead: number; rowsWritten: number }

interface Held extends Place, FindText { rowid: number; finderId: string; finderName: string; foundAt: number }

export interface StoreOptions {
  library: string;            // the library's text version (web/babel.js LIBRARY): finds name text at an address
  keep?: number;              // finds kept per side (the board's length)
  minClaim?: number;          // what a find needs to place while a side's board is not full
  now?: () => number;
}

const FINDS_INDEXES: [string, string][] = [
  ['finds_by_len', 'CREATE INDEX IF NOT EXISTS finds_by_len ON finds(len DESC, found_at)'],
  ['finds_side_len', 'CREATE INDEX IF NOT EXISTS finds_side_len ON finds(side, len DESC, found_at)'],
  ['finds_finder', 'CREATE INDEX IF NOT EXISTS finds_finder ON finds(finder)'],
];
const H_FROM = 'h_', H_TO = 'h`';   // ids from before 2026-10-02 start 'h_': the range [h_, h`) is exactly them
const USAGE_SAVE_MS = 60_000;

const placeKey = (p: Place) => `${p.side}/${p.floor}/${p.unit}/${p.shelf}/${p.slot}/${p.page}/${p.at}`;
const better = (a: Held, b: Held) => b.len - a.len || a.foundAt - b.foundAt || a.rowid - b.rowid;   // the boards' order
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export class Store {
  readonly library: string; readonly keep: number; readonly minClaim: number;
  private sql: Sql; private now: () => number;
  private use: Usage; private usageSavedAt = 0;
  private costs = new Map<string, OpCost>();
  private boards: [Held[], Held[]] | null = null;   // each side's board, best first: exactly the finds table's rows
  private byPlace = new Map<string, Held>();
  readonly migrated: { from: number; to: number; steps: string[] };

  // Opening is the wake: one read of meta and, unless the world is behind, nothing else.
  constructor(sql: Sql, o: StoreOptions) {
    this.sql = sql; this.library = o.library; this.keep = o.keep ?? 200; this.minClaim = o.minClaim ?? 9; this.now = o.now ?? Date.now;
    this.use = { day: day(this.now()), requests: 0, wsIn: 0, rowsRead: 0, rowsWritten: 0 };
    let meta: Record<string, string> = {};
    try {
      for (const r of this.run('wake', "SELECT key, value FROM meta WHERE key IN ('schema', 'library', 'usage')")) meta[r.key as string] = r.value as string;
    } catch { meta = {}; }   // no meta table: a new world
    // today's usage so far (saved once a minute), with this wake's reads added to it
    const saved = meta.usage ? safeJson(meta.usage) as Usage | null : null;
    if (saved && saved.day === this.use.day) for (const k of ['requests', 'wsIn', 'rowsRead', 'rowsWritten'] as const) this.use[k] += Number(saved[k]) || 0;
    const from = Number(meta.schema) || 0, steps: string[] = [];
    if (from < 1) { this.toV1(meta.library); steps.push('1'); }
    else if (meta.library !== this.library) { this.libraryChanged(meta.library, this.hasTable('finds')); steps.push('library'); }
    if (from < 2) { this.toV2(); steps.push('2'); }
    if (from < 3) { this.run('migrate', 'CREATE INDEX IF NOT EXISTS players_name ON players(name)'); steps.push('3'); }
    // 4: whether a falling person has already crossed the shaft this fall (one crossing a fall: src/body.ts judgeMove)
    if (from < 4) { if (!this.cols('players').has('crossed')) this.run('migrate', 'ALTER TABLE players ADD COLUMN crossed INTEGER NOT NULL DEFAULT 0'); steps.push('4'); }
    if (from < SCHEMA) this.run('migrate', "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", String(SCHEMA));
    this.migrated = { from, to: Math.max(from, SCHEMA), steps };
  }

  // ------------------------------------------------------------------ counting
  private run(op: string, q: string, ...b: SqlValue[]): Row[] {
    const c = this.sql.exec(q, ...b), rows = c.toArray();
    this.account(op, c.rowsRead, c.rowsWritten);
    return rows;
  }
  private roll() {   // a new UTC day starts from nothing
    const today = day(this.now());
    if (this.use.day !== today) this.use = { day: today, requests: 0, wsIn: 0, rowsRead: 0, rowsWritten: 0 };
  }
  private account(op: string, read: number, written: number) {
    this.roll();
    this.use.rowsRead += read; this.use.rowsWritten += written;
    const c = this.costs.get(op) ?? { calls: 0, rowsRead: 0, rowsWritten: 0 };
    c.calls++; c.rowsRead += read; c.rowsWritten += written; this.costs.set(op, c);
  }
  // A Durable Object request (each fetch, RPC and alarm) or a WebSocket message in; today's figures are saved at most
  // once a minute (and on the first count after waking).
  count(kind: 'requests' | 'wsIn') {
    this.roll(); this.use[kind]++;
    const now = this.now();
    if (now - this.usageSavedAt > USAGE_SAVE_MS) { this.usageSavedAt = now; this.run('usage', "INSERT OR REPLACE INTO meta (key, value) VALUES ('usage', ?)", JSON.stringify(this.use)); }
  }
  usage(): Usage { this.roll(); return { ...this.use }; }
  // Rows read and written by each operation since this wake.
  costsSinceWake(): Record<string, OpCost> { return Object.fromEntries([...this.costs].map(([k, v]) => [k, { ...v }])); }

  // ------------------------------------------------------------------ migrations
  private cols(t: string) { return new Set(this.run('migrate', `SELECT name FROM pragma_table_info('${t}')`).map(r => r.name as string)); }
  private hasTable(t: string) { return this.run('migrate', "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t).length > 0; }
  private toV1(library: string | undefined) {
    const m = (q: string, ...b: SqlValue[]) => this.run('migrate', q, ...b);
    m(`CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, floor INTEGER NOT NULL, yaw REAL NOT NULL, updated_at INTEGER NOT NULL,
        farthest_y REAL NOT NULL DEFAULT 0, farthest_floor INTEGER NOT NULL DEFAULT 0, farthest_at INTEGER,
        books_opened INTEGER NOT NULL DEFAULT 0, connected INTEGER NOT NULL DEFAULT 0,
        fall_t0 INTEGER, fall_floor INTEGER)`);
    m(`CREATE TABLE IF NOT EXISTS marks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, night INTEGER NOT NULL,
        floor INTEGER NOT NULL, unit INTEGER NOT NULL, shelf INTEGER NOT NULL, slot INTEGER NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    m('CREATE INDEX IF NOT EXISTS marks_place ON marks(night, floor, unit)');
    m(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, author TEXT, type TEXT NOT NULL, payload TEXT NOT NULL)`);
    m(`CREATE TABLE IF NOT EXISTS agent_keys (
        key_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL, name TEXT NOT NULL, rate_per_min INTEGER NOT NULL,
        created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`);
    m('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    m("DELETE FROM marks WHERE kind = 'note'");   // notes were removed before launch: none left standing
    // Older worlds: a side column for people and marks (everyone so far was in the east gallery).
    const pc = this.cols('players');
    if (!pc.has('side')) m('ALTER TABLE players ADD COLUMN side INTEGER NOT NULL DEFAULT 0');
    if (!this.cols('marks').has('side')) m('ALTER TABLE marks ADD COLUMN side INTEGER NOT NULL DEFAULT 0');
    // Identity (2026-10-02): a human's id used to be 'h_' + the secret their browser logs in with, and it went out in
    // peers, the roster and the event log. Every player gets a random public id (agents keep theirs), humans log in by
    // a secret kept only as a hash, and the old ids are rewritten out of the public log.
    if (!pc.has('pub_id')) m('ALTER TABLE players ADD COLUMN pub_id TEXT');
    if (!pc.has('secret_hash')) m('ALTER TABLE players ADD COLUMN secret_hash TEXT');
    if (!pc.has('name_locked')) m('ALTER TABLE players ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0');
    for (const r of m('SELECT id FROM players WHERE pub_id IS NULL'))
      m('UPDATE players SET pub_id = ? WHERE id = ?', r.id && String(r.id).startsWith('a_') ? r.id : 'p_' + randomHex(8), r.id);
    m('CREATE UNIQUE INDEX IF NOT EXISTS players_pub ON players(pub_id)');
    m('CREATE UNIQUE INDEX IF NOT EXISTS players_secret ON players(secret_hash) WHERE secret_hash IS NOT NULL');
    m(`UPDATE events SET author = (SELECT pub_id FROM players WHERE players.id = events.author)
      WHERE author IS NOT NULL AND author IN (SELECT id FROM players WHERE pub_id IS NOT NULL AND pub_id <> id)`);
    // A finds table from before the sides is put aside whatever the library version says.
    const hasFinds = this.hasTable('finds'), stale = hasFinds && !this.cols('finds').has('side');
    if (library !== this.library || stale) this.libraryChanged(library, hasFinds);
    this.createFinds();
  }
  private toV2() {
    this.createFinds();
    this.run('migrate', 'CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at)');
    this.run('migrate', `CREATE INDEX IF NOT EXISTS events_h_author ON events(author) WHERE author >= '${H_FROM}' AND author < '${H_TO}'`);
  }
  // The finds table and its indexes. An archive renamed by an older world took its indexes' names with it (ALTER TABLE
  // RENAME keeps them), which left the new table without them: those are dropped from the archive and made here.
  private createFinds() {
    this.run('migrate', `CREATE TABLE IF NOT EXISTS finds (
        side INTEGER NOT NULL, floor INTEGER NOT NULL, unit INTEGER NOT NULL, shelf INTEGER NOT NULL, slot INTEGER NOT NULL,
        page INTEGER NOT NULL, at INTEGER NOT NULL, len INTEGER NOT NULL, words INTEGER NOT NULL, text TEXT NOT NULL,
        finder TEXT NOT NULL, finder_name TEXT NOT NULL, found_at INTEGER NOT NULL,
        PRIMARY KEY (side, floor, unit, shelf, slot, page, at))`);
    const names = FINDS_INDEXES.map(([n]) => n);
    for (const r of this.run('migrate', `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name IN (${names.map(() => '?').join(',')})`, ...names))
      if (r.tbl_name !== 'finds') this.run('migrate', `DROP INDEX ${String(r.name).replace(/[^a-z0-9_]/gi, '')}`);
    for (const [, q] of FINDS_INDEXES) this.run('migrate', q);
  }
  // Finds and marks name text at an address. When the library's text changes, that text is no longer there: the old
  // finds are kept aside in finds_<old version> (renamed, not deleted), the marks go, and the board starts empty.
  private libraryChanged(was: string | undefined, hasFinds: boolean) {
    const m = (q: string, ...b: SqlValue[]) => this.run('migrate', q, ...b);
    const old = `finds_${(was === this.library ? 'before_sides' : was ?? 'original').replace(/[^a-z0-9]/gi, '_')}`;
    let count = 0;
    if (hasFinds) {
      count = m('SELECT COUNT(*) AS n FROM finds')[0].n as number;
      if (this.hasTable(old)) { m(`INSERT INTO ${old} SELECT * FROM finds`); m('DROP TABLE finds'); }
      else {
        for (const [n] of FINDS_INDEXES) m(`DROP INDEX IF EXISTS ${n}`);   // so the new finds table can have them
        m(`ALTER TABLE finds RENAME TO ${old}`);
      }
    }
    m('DELETE FROM marks');
    m("INSERT OR REPLACE INTO meta (key, value) VALUES ('library', ?)", this.library);
    this.appendEvent(null, 'library', { from: was ?? null, to: this.library, findsKeptAside: count, table: hasFinds ? old : null });
    this.createFinds();
    this.boards = null; this.byPlace.clear();
  }

  // ------------------------------------------------------------------ players
  // Every player there has ever been: the owner's whole-world operations only (reset), never a wake.
  allPlayers(kind?: Kind): PlayerRecord[] {
    return (kind ? this.run('allPlayers', 'SELECT * FROM players WHERE kind = ?', kind) : this.run('allPlayers', 'SELECT * FROM players')).map(rowToPlayer);
  }
  // One player, by an index each: the primary key, the secret's hash (players_secret), the public id (players_pub).
  playerById(id: string): PlayerRecord | null { const r = this.run('player', 'SELECT * FROM players WHERE id = ?', id)[0]; return r ? rowToPlayer(r) : null; }
  playerBySecret(hash: string): PlayerRecord | null { const r = this.run('player', 'SELECT * FROM players WHERE secret_hash = ?', hash)[0]; return r ? rowToPlayer(r) : null; }
  playerByPub(pubId: string): PlayerRecord | null { const r = this.run('player', 'SELECT * FROM players WHERE pub_id = ?', pubId)[0]; return r ? rowToPlayer(r) : null; }
  // Waking: the players these ids name (the ones the open sockets belong to), by primary key.
  playersById(ids: string[]): PlayerRecord[] {
    const out: PlayerRecord[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      out.push(...this.run('wakePlayers', `SELECT * FROM players WHERE id IN (${part.map(() => '?').join(',')})`, ...part).map(rowToPlayer));
    }
    return out;
  }
  // Waking: agents (players with a live key) whose record changed since `since`: those still counted present.
  agentsSeenSince(since: number): PlayerRecord[] {
    return this.run('wakePlayers', `SELECT players.* FROM agent_keys JOIN players ON players.id = agent_keys.player_id
      WHERE agent_keys.revoked = 0 AND players.updated_at > ?`, since).map(rowToPlayer);
  }
  // Is anyone called this? (players_name)
  nameTaken(name: string) { return this.run('nameTaken', 'SELECT 1 AS hit FROM players WHERE name = ? LIMIT 1', name).length > 0; }
  // The map's roster: the `limit` most recently seen since `since`. A whole-table read (no index on updated_at, which
  // every save changes and so would cost a row written each time): the world asks once a wake and keeps it fresh.
  recentPlayers(since: number, limit: number): PlayerRecord[] {
    return this.run('roster', 'SELECT * FROM players WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?', since, limit).map(rowToPlayer);
  }
  // Everyone in the shaft (x > 0: falling humans, and agents, which fall at x = 1): night puts them back. Once a night.
  inShaft(): PlayerRecord[] { return this.run('inShaft', 'SELECT * FROM players WHERE x > 0 OR fall_t0 IS NOT NULL').map(rowToPlayer); }
  // The owner's diag: how many players there are, and how many humans from before secrets (whole-table counts).
  playerCounts() {
    const r = this.run('playerCounts', "SELECT COUNT(*) AS n, SUM(kind = 'human' AND secret_hash IS NULL) AS legacy, SUM(kind = 'agent') AS agents FROM players")[0];
    return { n: (r.n as number) ?? 0, legacy: (r.legacy as number) ?? 0, agents: (r.agents as number) ?? 0 };
  }
  // Insert a player, or update everything about them but their name and secret (renamePlayer and setSecret).
  savePlayer(p: PlayerRecord) {
    this.run('savePlayer', `INSERT INTO players (id, kind, name, x, y, floor, yaw, updated_at, farthest_y, farthest_floor, farthest_at, books_opened, connected, fall_t0, fall_floor, side, pub_id, secret_hash, name_locked, crossed)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET x=excluded.x, y=excluded.y, floor=excluded.floor, yaw=excluded.yaw, side=excluded.side, name_locked=excluded.name_locked,
        updated_at=excluded.updated_at, farthest_y=excluded.farthest_y, farthest_floor=excluded.farthest_floor, farthest_at=excluded.farthest_at,
        books_opened=excluded.books_opened, connected=excluded.connected, fall_t0=excluded.fall_t0, fall_floor=excluded.fall_floor, crossed=excluded.crossed`,
      p.id, p.kind, p.name, p.x, p.y, p.floor, p.yaw, p.updatedAt, p.farthestY, p.farthestFloor, p.farthestAt, p.booksOpened,
      p.connected ? 1 : 0, p.fall?.t0 ?? null, p.fall?.floor ?? null, p.side, p.pubId, p.secretHash, p.nameLocked ? 1 : 0, p.crossed ? 1 : 0);
  }
  // A new name alone (the owner's reset: finds and marks keep the names they were made under).
  setName(id: string, name: string) { this.run('setName', 'UPDATE players SET name = ? WHERE id = ?', name, id); }
  // A human's new secret (the old one stops working).
  setSecret(id: string, hash: string) { this.run('setSecret', 'UPDATE players SET secret_hash = ? WHERE id = ?', hash, id); }
  // A player's new name, and the leaderboard and the marks show them by it.
  renamePlayer(id: string, name: string) {
    this.run('rename', 'UPDATE players SET name = ? WHERE id = ?', name, id);
    this.run('rename', 'UPDATE finds SET finder_name = ? WHERE finder = ?', name, id);
    this.run('rename', 'UPDATE marks SET author_name = ? WHERE author = ?', name, id);
    for (const h of this.byPlace.values()) if (h.finderId === id) h.finderName = name;
  }
  // Moderation: a player, their finds and their marks; returns how many finds went.
  removePlayer(id: string) {
    const gone = this.run('remove', 'DELETE FROM finds WHERE finder = ? RETURNING rowid AS rid', id).length;
    this.run('remove', 'DELETE FROM marks WHERE author = ?', id);
    this.run('remove', 'DELETE FROM players WHERE id = ?', id);
    if (gone && this.boards) for (const sd of [0, 1] as const) {
      for (const h of this.boards[sd]) if (h.finderId === id) this.byPlace.delete(placeKey(h));
      this.boards[sd] = this.boards[sd].filter(h => h.finderId !== id);
    }
    return gone;
  }

  // ------------------------------------------------------------------ events
  appendEvent(author: string | null, type: string, payload: unknown, at = this.now()) {
    this.run('event', 'INSERT INTO events (at, author, type, payload) VALUES (?,?,?,?)', at, author, type, JSON.stringify(payload));
  }
  eventsSince(since: number, limit: number) {
    return this.run('eventsSince', 'SELECT id, at, author, type, payload FROM events WHERE id > ? ORDER BY id LIMIT ?', since, Math.max(1, Math.min(500, limit)))
      .map(e => ({ ...e, payload: JSON.parse(e.payload as string) as unknown }));
  }

  // ------------------------------------------------------------------ marks
  marksNear(night: number, side: number, floor: number, y: number, floors: number, metres: number): Mark[] {
    return this.run('marksNear', 'SELECT * FROM marks WHERE night = ? AND side = ? AND floor BETWEEN ? AND ? AND unit BETWEEN ? AND ? ORDER BY id LIMIT 500',
      night, side, floor - floors, floor + floors, Math.floor(y - metres), Math.ceil(y + metres)).map(rowToMark);
  }
  marksTonight(night: number, author: string) {
    return this.run('markCount', 'SELECT COUNT(*) AS c FROM marks WHERE night = ? AND author = ?', night, author)[0].c as number;
  }
  addMark(m: Omit<Mark, 'id' | 'author'> & { author: string; authorName: string }): Mark {
    return rowToMark(this.run('addMark',
      'INSERT INTO marks (night, side, floor, unit, shelf, slot, kind, text, author, author_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *',
      m.night, m.side, m.floor, m.unit, m.shelf, m.slot, m.kind, m.text, m.author, m.authorName, m.createdAt)[0]);
  }
  clearMarksBefore(night: number) { this.run('nightfall', 'DELETE FROM marks WHERE night < ?', night); }

  // ------------------------------------------------------------------ the boards
  // Each side keeps its keep longest finds (ties: the earlier found, then the earlier written). The table holds exactly
  // those rows, read once per wake; from then on the store's copy is the board and only writes go to SQLite.
  private held(): [Held[], Held[]] {
    if (this.boards) return this.boards;
    const boards: [Held[], Held[]] = [[], []];
    for (const sd of [0, 1] as const) {
      let rows = this.run('loadBoard', `SELECT rowid AS rid, side, floor, unit, shelf, slot, page, at, len, words, text, finder, finder_name, found_at
        FROM finds WHERE side = ? ORDER BY len DESC, found_at, rowid LIMIT ?`, sd, this.keep + 1);
      if (rows.length > this.keep) {   // more than a board's worth (not written by this store): trimmed once, as before
        this.run('trimBoard', 'DELETE FROM finds WHERE side = ? AND rowid NOT IN (SELECT rowid FROM finds WHERE side = ? ORDER BY len DESC, found_at, rowid LIMIT ?)', sd, sd, this.keep);
        rows = rows.slice(0, this.keep);
      }
      boards[sd] = rows.map(r => ({ rowid: r.rid as number, side: sd, floor: r.floor as number, unit: r.unit as number, shelf: r.shelf as number,
        slot: r.slot as number, page: r.page as number, at: r.at as number, len: r.len as number, words: r.words as number, text: r.text as string,
        finderId: r.finder as string, finderName: r.finder_name as string, foundAt: r.found_at as number }));
    }
    this.byPlace.clear();
    for (const b of boards) for (const h of b) this.byPlace.set(placeKey(h), h);
    return (this.boards = boards);
  }
  // What a find on each side must reach to place: one more than the side's keep-th, or minClaim while there is room.
  boardMins(): [number, number] {
    const b = this.held(), min = (l: Held[]) => l.length >= this.keep ? l[this.keep - 1].len + 1 : this.minClaim;
    return [min(b[0]), min(b[1])];
  }
  board(limit: number): Board {
    const b = this.held(), n = Math.max(1, Math.min(this.keep, limit));
    const top = [...b[0].slice(0, n), ...b[1].slice(0, n)].sort(better).slice(0, n);
    return { top: top.map(boardRow), sides: [b[0].slice(0, n).map(boardRow), b[1].slice(0, n).map(boardRow)], mins: this.boardMins() };
  }
  // A find already on a board, by where it is.
  known(at: Place): FindText | undefined {
    this.held(); const h = this.byPlace.get(placeKey(at));
    return h && { len: h.len, words: h.words, text: h.text };
  }
  // Writes a find (the first to claim a place keeps it) and says who has it and where it ranks on its side and on both.
  claim(f: Place & FindText, finderId: string, finderName: string, now: number): Claimed {
    const b = this.held();
    const ins = this.run('claim', `INSERT INTO finds (side, floor, unit, shelf, slot, page, at, len, words, text, finder, finder_name, found_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING rowid AS rid`,
      f.side, f.floor, f.unit, f.shelf, f.slot, f.page, f.at, f.len, f.words, f.text, finderId, finderName, now);
    const first = ins.length > 0;
    let h = this.byPlace.get(placeKey(f));
    if (first) {
      h = { rowid: ins[0].rid as number, side: f.side, floor: f.floor, unit: f.unit, shelf: f.shelf, slot: f.slot, page: f.page, at: f.at,
        len: f.len, words: f.words, text: f.text, finderId, finderName, foundAt: now };
      const list = b[f.side], i = list.findIndex(o => better(h!, o) < 0);
      list.splice(i < 0 ? list.length : i, 0, h); this.byPlace.set(placeKey(h), h);
    }
    if (!h) {   // taken, but not on the board: cannot happen while this store is the only writer; asked of SQLite then
      const pk = [f.side, f.floor, f.unit, f.shelf, f.slot, f.page, f.at];
      const row = this.run('claim', 'SELECT finder_name, found_at FROM finds WHERE side=? AND floor=? AND unit=? AND shelf=? AND slot=? AND page=? AND at=?', ...pk)[0];
      const ahead = (side: boolean) => (this.run('claim', `SELECT COUNT(*) AS n FROM finds WHERE (len > ? OR (len = ? AND found_at < ?))${side ? ' AND side = ?' : ''}`,
        f.len, f.len, row.found_at, ...(side ? [f.side] : []))[0].n as number) + 1;
      return { first, finder: row.finder_name as string, foundAt: row.found_at as number, rank: ahead(true), overall: ahead(false) };
    }
    const found = h, ahead = (l: Held[]) => l.reduce((n, o) => n + (o.len > f.len || (o.len === f.len && o.foundAt < found.foundAt) ? 1 : 0), 0);
    const rank = ahead(b[f.side]) + 1, overall = rank + ahead(b[1 - f.side]);
    return { first, finder: h.finderName, foundAt: h.foundAt, rank, overall };
  }
  // After a message's claims: each side back to its keep best.
  trimBoard() {
    const b = this.held(), gone: number[] = [];
    for (const l of b) while (l.length > this.keep) { const h = l.pop()!; this.byPlace.delete(placeKey(h)); gone.push(h.rowid); }
    if (gone.length) this.run('trimBoard', `DELETE FROM finds WHERE rowid IN (${gone.map(() => '?').join(',')})`, ...gone);
  }
  clearFinds() { this.run('clearFinds', 'DELETE FROM finds'); this.boards = [[], []]; this.byPlace.clear(); }
  findsCount() { return this.run('findsCount', 'SELECT COUNT(*) AS n FROM finds')[0].n as number; }
  // An agent's view: the known finds on their side and floor within a stretch of gallery.
  findsNear(side: number, floor: number, lo: number, hi: number, limit: number) {
    return this.run('findsNear', `SELECT side, floor, unit, shelf, slot, page, at, len, text, finder_name AS finder, substr(finder, 1, 2) = 'a_' AS agent FROM finds
      WHERE side = ? AND floor = ? AND unit BETWEEN ? AND ? ORDER BY len DESC, found_at LIMIT ?`, side, floor, lo, hi, limit);
  }

  // ------------------------------------------------------------------ agent keys
  addAgentKey(keyHash: string, playerId: string, name: string, ratePerMin: number, at: number) {
    this.run('agentKeys', 'INSERT INTO agent_keys (key_hash, player_id, name, rate_per_min, created_at) VALUES (?,?,?,?,?)', keyHash, playerId, name, ratePerMin, at);
  }
  listAgentKeys() {
    return this.run('agentKeys', 'SELECT player_id AS id, name, rate_per_min AS ratePerMin, created_at AS createdAt, revoked FROM agent_keys ORDER BY created_at');
  }
  revokeAgentKey(playerId: string) { return this.run('agentKeys', 'UPDATE agent_keys SET revoked = 1 WHERE player_id = ? RETURNING 1 AS ok', playerId).length > 0; }
  agentByKeyHash(keyHash: string) {
    const r = this.run('agentAuth', 'SELECT player_id, name FROM agent_keys WHERE key_hash = ? AND revoked = 0', keyHash)[0];
    return r ? { id: r.player_id as string, name: r.name as string } : null;
  }
  agentRate(playerId: string) {
    return this.run('agentRate', 'SELECT rate_per_min FROM agent_keys WHERE player_id = ? AND revoked = 0 LIMIT 1', playerId)[0]?.rate_per_min as number | undefined;
  }

  // ------------------------------------------------------------------ owner
  // A fresh start: every human, find (and every archived board), mark and event. Agents and their keys stay.
  wipe() {
    const before = { finds: this.findsCount(), events: this.run('wipe', 'SELECT COUNT(*) AS n FROM events')[0].n as number };
    const archives = this.run('wipe', "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'finds\\_%' ESCAPE '\\'").map(r => r.name as string);
    for (const t of archives) this.run('wipe', `DROP TABLE ${t.replace(/[^a-z0-9_]/gi, '')}`);
    this.run('wipe', "DELETE FROM players WHERE kind = 'human'"); this.clearFinds(); this.run('wipe', 'DELETE FROM marks'); this.run('wipe', 'DELETE FROM events');
    return { ...before, archives };
  }
  // The owner's figures for checking a migration took, and the names that appeared or changed since `since` (ms).
  // Index searches only: events are only ever appended (wipe deletes them all), so their count is the span of ids.
  diag(since: number) {
    const one = (q: string, ...b: SqlValue[]) => this.run('diag', q, ...b)[0];
    const span = one('SELECT (SELECT MAX(id) FROM events) - (SELECT MIN(id) FROM events) + 1 AS n').n as number | null;
    return {
      players: {
        noPub: one('SELECT COUNT(*) AS n FROM players WHERE pub_id IS NULL').n as number,
        hPub: one('SELECT COUNT(*) AS n FROM players WHERE pub_id >= ? AND pub_id < ?', H_FROM, H_TO).n as number,
      },
      events: { n: span ?? 0, hAuthor: one(`SELECT COUNT(*) AS n FROM events WHERE author >= '${H_FROM}' AND author < '${H_TO}'`).n as number },
      names: this.run('diag', `SELECT events.at, events.type, events.author AS id,
          COALESCE(json_extract(events.payload, '$.to'), json_extract(events.payload, '$.name')) AS gave, players.name, players.side,
          (SELECT COUNT(*) FROM finds WHERE finds.finder = players.id) AS finds
        FROM events JOIN players ON players.pub_id = events.author
        WHERE events.type IN ('arrive', 'rename') AND events.at > ? AND players.kind = 'human' ORDER BY events.at LIMIT 500`, since),
    };
  }
}

// ------------------------------------------------------------------ rows
function rowToPlayer(r: Row): PlayerRecord {
  return {
    id: r.id as string, kind: r.kind as Kind, name: r.name as string, pubId: (r.pub_id as string) ?? (r.id as string), secretHash: (r.secret_hash as string | null) ?? null, nameLocked: !!r.name_locked,
    x: r.x as number, y: r.y as number, floor: r.floor as number, yaw: r.yaw as number, side: (r.side as number) === 1 ? 1 : 0, updatedAt: r.updated_at as number,
    farthestY: r.farthest_y as number, farthestFloor: r.farthest_floor as number, farthestAt: r.farthest_at as number | null,
    booksOpened: r.books_opened as number, connected: !!r.connected,
    fall: r.fall_t0 == null ? null : { t0: r.fall_t0 as number, floor: r.fall_floor as number }, crossed: !!r.crossed,
  };
}
function rowToMark(r: Row): Mark {
  return { id: r.id as number, night: r.night as number, side: (r.side as number) === 1 ? 1 : 0, floor: r.floor as number, unit: r.unit as number, shelf: r.shelf as number,
    slot: r.slot as number, kind: r.kind as string, text: r.text as string, author: r.author_name as string, createdAt: r.created_at as number };
}
function boardRow(h: Held): BoardRow {
  return { side: h.side, floor: h.floor, unit: h.unit, shelf: h.shelf, slot: h.slot, page: h.page, at: h.at, len: h.len, words: h.words, text: h.text,
    finder: h.finderName, agent: h.finderId.startsWith('a_') ? 1 : 0, foundAt: h.foundAt };
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
function randomHex(bytes: number) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(x => x.toString(16).padStart(2, '0')).join(''); }
