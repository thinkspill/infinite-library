// Node's node:sqlite adapted to the store's seam (src/store.ts Sql), for checks that run the store, or the whole world
// core, with no server: scripts/check-store.ts, check-world.ts.
//
// Node's node:sqlite reports no rows read, so the adapter estimates them: the rows a statement returns, or, if more,
// the whole size of the tables its query plan (EXPLAIN QUERY PLAN) SCANs. Index searches count only what they return,
// so the figures understate an index range walk (e.g. a COUNT over an index) but never hide a full scan. Rows written
// are SQLite's changes() (table rows, not index entries). Every statement is logged with its plan while `capture` is on.
import { DatabaseSync } from 'node:sqlite';
import type { Sql, SqlValue, Row, Cursor } from '../src/store.ts';

export interface Logged { q: string; plan: string[]; scans: string[]; returned: number; estRead: number; written: number }
export function nodeSql(db: DatabaseSync) {
  const log: Logged[] = [];
  const size = (t: string) => {
    const known = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    return known ? Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n) : 0;
  };
  const sql: Sql & { log: Logged[]; capture: boolean } = {
    log, capture: true,
    exec<T extends Row = Row>(q: string, ...b: SqlValue[]): Cursor<T> {
      const plan = sql.capture && /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(q)
        ? (db.prepare('EXPLAIN QUERY PLAN ' + q).all(...(b as (string | number | null)[])) as { detail: string }[]).map(r => r.detail) : [];
      const scans = plan.map(d => /^SCAN (\w+)/.exec(d)?.[1]).filter((t): t is string => !!t && t !== 'CONSTANT');
      const scanned = scans.reduce((n, t) => n + size(t), 0);
      const st = db.prepare(q);
      let rows: T[] = [], written = 0;
      if (st.columns().length) {
        rows = st.all(...(b as (string | number | null)[])) as T[];
        if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(q)) written = rows.length;
      } else written = Number(st.run(...(b as (string | number | null)[])).changes);
      const estRead = Math.max(rows.length, scanned);
      if (sql.capture) log.push({ q: q.replace(/\s+/g, ' ').trim(), plan, scans, returned: rows.length, estRead, written });
      return {
        toArray: () => rows,
        one: () => { if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`); return rows[0]; },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
        rowsRead: estRead, rowsWritten: written,
      };
    },
  };
  return sql;
}
