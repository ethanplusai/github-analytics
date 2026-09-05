import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// DatabaseSync hands back rows with a null prototype. That's invisible to
// callers that just read properties, but it fails assert.deepEqual (which
// node:assert/strict aliases to deepStrictEqual, and that compares
// [[Prototype]]) against a plain object literal. Spreading each row here
// keeps the driver's output ordinary-object-shaped for both engines.
function toPlainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

export function createSqliteDriver(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // Postgres spells the two-argument maximum GREATEST(a, b); SQLite spells it
  // max(a, b) and has no GREATEST. The store's SQL is written once, in the
  // Postgres spelling, and SQLite learns the name here — which is what keeps
  // the monotonic traffic upsert byte-identical on both engines. The NULL
  // handling deliberately mirrors Postgres's GREATEST, which ignores NULL
  // arguments and only returns NULL when every argument is NULL — not
  // SQLite's native max(), which returns NULL if any argument is NULL. A
  // plain `a > b ? a : b` also gets this wrong on its own terms: JS coerces
  // null to 0 for the comparison, so greatest(null, -5) would wrongly pick
  // the null branch instead of -5.
  db.function('greatest', (a, b) => {
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    return a > b ? a : b;
  });

  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(readFileSync(join(HERE, 'schema.sqlite.sql'), 'utf8'));
  db.exec('PRAGMA user_version = 1');

  return {
    dialect: 'sqlite',

    async query(sql, params = []) {
      // `.all()` on a non-SELECT runs the statement and returns [] — verified
      // on Node 22.23.1 — so one path serves SELECT and RETURNING alike.
      return toPlainRows(db.prepare(sql).all(...params));
    },

    async run(sql, params = []) {
      const result = db.prepare(sql).run(...params);
      return { rowCount: Number(result.changes) };
    },

    async transaction(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => toPlainRows(db.prepare(sql).all(...params)));
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    async close() {
      db.close();
    },
  };
}
