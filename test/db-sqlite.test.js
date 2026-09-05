import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteDriver } from '../src/db/sqlite.js';

test('query returns rows and run reports affected rows', async () => {
  const d = createSqliteDriver(':memory:');
  await d.run("INSERT INTO meta (key, value) VALUES (?, ?)", ['a', '1']);
  const rows = await d.query('SELECT key, value FROM meta', []);
  assert.deepEqual(rows, [{ key: 'a', value: '1' }]);
  const res = await d.run("UPDATE meta SET value = ? WHERE key = ?", ['2', 'a']);
  assert.equal(res.rowCount, 1);
  await d.close();
});

test('greatest() is available so the monotonic upsert works', async () => {
  const d = createSqliteDriver(':memory:');
  const rows = await d.query('SELECT greatest(3, 7) AS v', []);
  assert.equal(rows[0].v, 7);
  await d.close();
});

test('transaction rolls back entirely on failure', async () => {
  const d = createSqliteDriver(':memory:');
  await assert.rejects(() => d.transaction([
    { sql: "INSERT INTO meta (key, value) VALUES ('x', '1')", params: [] },
    { sql: 'INSERT INTO nonexistent_table (a) VALUES (1)', params: [] },
  ]));
  assert.deepEqual(await d.query('SELECT * FROM meta', []), []);
  await d.close();
});

test('transaction returns RETURNING rows per statement', async () => {
  const d = createSqliteDriver(':memory:');
  const results = await d.transaction([
    { sql: "INSERT INTO poll_runs (started_at) VALUES (?) RETURNING id", params: ['2026-01-01T00:00:00Z'] },
  ]);
  assert.equal(results[0][0].id, 1);
  await d.close();
});

test('greatest() with NULL and a negative number ignores the NULL, in both orders', async () => {
  const d = createSqliteDriver(':memory:');
  assert.equal((await d.query('SELECT greatest(NULL, -5) AS v', []))[0].v, -5);
  assert.equal((await d.query('SELECT greatest(-5, NULL) AS v', []))[0].v, -5);
  await d.close();
});

test('greatest() with NULL and a positive number ignores the NULL, in both orders', async () => {
  const d = createSqliteDriver(':memory:');
  assert.equal((await d.query('SELECT greatest(NULL, 5) AS v', []))[0].v, 5);
  assert.equal((await d.query('SELECT greatest(5, NULL) AS v', []))[0].v, 5);
  await d.close();
});

test('greatest(null, null) is null', async () => {
  const d = createSqliteDriver(':memory:');
  assert.equal((await d.query('SELECT greatest(NULL, NULL) AS v', []))[0].v, null);
  await d.close();
});

test('greatest() with a tie returns that value', async () => {
  const d = createSqliteDriver(':memory:');
  assert.equal((await d.query('SELECT greatest(4, 4) AS v', []))[0].v, 4);
  await d.close();
});

test('greatest() with two negative numbers returns the one closer to zero', async () => {
  const d = createSqliteDriver(':memory:');
  assert.equal((await d.query('SELECT greatest(-3, -9) AS v', []))[0].v, -3);
  await d.close();
});
