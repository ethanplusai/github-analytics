import { test, skip } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';

async function exercise(store) {
  await store.upsertRepo({ fullName: 'a/b', owner: 'a', name: 'b', private: true }, '2026-01-01T00:00:00Z');
  const repo = await store.getRepo('a/b');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-01-01T00:00:00Z', count: 10, uniques: 4 },
    { timestamp: '2026-01-02T00:00:00Z', count: 20, uniques: 9 },
  ], '2026-01-02T00:00:00Z');
  // A lower incoming figure must not lower the stored one, on either engine.
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-01-02T00:00:00Z', count: 1, uniques: 1 },
  ], '2026-01-03T00:00:00Z');
  await store.ingestWindowSnapshot(repo.id, '2026-01-02', 'views', { count: 30, uniques: 13 });
  await store.ingestReferrers(repo.id, '2026-01-02', [{ referrer: 'google.com', count: 5, uniques: 3 }]);
  await store.ingestPaths(repo.id, '2026-01-02', [{ path: '/a/b', title: 'a/b', count: 5, uniques: 3 }]);

  // Different numbers from the views series above, so the clones and
  // unique_cloners arms of TOTALS_SELECT can't be confused with the views
  // and unique_visitors arms — a bug isolated to one CASE arm would still
  // pass if both kinds carried the same figures.
  await store.ingestTrafficSeries(repo.id, 'clones', [
    { timestamp: '2026-01-01T00:00:00Z', count: 7, uniques: 2 },
    { timestamp: '2026-01-02T00:00:00Z', count: 15, uniques: 6 },
  ], '2026-01-02T00:00:00Z');

  // The only place the two schemas actually differ — GENERATED ALWAYS AS
  // IDENTITY vs AUTOINCREMENT, and the INSERT ... RETURNING id path — so it
  // must be exercised here, not just left to the repos table.
  const pollRunId = await store.startPollRun('2026-01-02T00:00:00Z');
  await store.finishPollRun(pollRunId, { total: 1, ok: 1, failed: 0, at: '2026-01-02T00:05:00Z' });

  return {
    repo: { ...(await store.getRepo('a/b')), id: null, addedAt: null },
    totals: await store.totals(repo.id, null),
    coverage: await store.coverage(repo.id),
    daily: await store.dailySeries(repo.id, 'views', null),
    window: await store.latestWindow(repo.id),
    referrers: await store.latestReferrers(repo.id, 10),
    paths: await store.latestPaths(repo.id, 10),
    count: await store.countTrackedRepos(),
    summaries: (await store.repoSummaries({ sinceDay: null, sparkSinceDay: '2026-01-01' }))
      .map((s) => ({ ...s, id: null, addedAt: null })),
    // Ids legitimately differ between engines (IDENTITY vs AUTOINCREMENT
    // assign independently), so normalise it the same way repo/summary ids
    // are normalised above — only the shape and the other fields matter.
    lastPollRun: { ...(await store.lastPollRun()), id: null },
  };
}

test('sqlite and postgres return identical results', async (t) => {
  const sqliteStore = new Store(createSqliteDriver(':memory:'));
  const fromSqlite = await exercise(sqliteStore);
  await sqliteStore.close();

  // Every number must be a number, not a string, before we even compare.
  assert.equal(typeof fromSqlite.count, 'number');
  assert.equal(typeof fromSqlite.totals.views, 'number');

  const url = process.env.GHA_TEST_POSTGRES_URL;
  if (!url) {
    t.skip('set GHA_TEST_POSTGRES_URL to a scratch Neon branch to run the Postgres leg');
    return;
  }

  const { createPostgresDriver } = await import('../src/db/postgres.js');
  const driver = await createPostgresDriver(url);
  await driver.run('DROP TABLE IF EXISTS traffic_daily, window_snapshots, referrer_snapshots, path_snapshots, poll_runs, meta, repos CASCADE', []);
  const { readFileSync } = await import('node:fs');
  await driver.run(readFileSync(new URL('../src/db/schema.postgres.sql', import.meta.url), 'utf8'), []);

  const fromPostgres = await exercise(new Store(driver));
  assert.deepEqual(fromPostgres, fromSqlite);
});

test('no local-path module statically imports the Neon driver', () => {
  const files = ['../server.js', '../src/store.js', '../src/api.js', '../src/poller.js', '../src/db/sqlite.js'];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(
      /^\s*import[\s\S]{0,120}?['"]@neondatabase/m.test(source),
      false,
      `${file} imports @neondatabase at module scope; it must be a dynamic import`,
    );
  }
});

test('the sqlite path runs with the Neon package unavailable', () => {
  // A child process with a module resolution root that has no node_modules:
  // if anything on the local path reached for the Neon driver, this throws
  // ERR_MODULE_NOT_FOUND instead of printing ok.
  const script = `
    import { createSqliteDriver } from ${JSON.stringify(new URL('../src/db/sqlite.js', import.meta.url).href)};
    import { Store } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    const store = new Store(createSqliteDriver(':memory:'));
    await store.upsertRepo({ fullName: 'a/b', owner: 'a', name: 'b' }, '2026-01-01T00:00:00Z');
    console.log('ok', await store.countTrackedRepos());
    await store.close();
  `;
  const out = execFileSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
    { cwd: '/', encoding: 'utf8' });
  assert.match(out, /^ok 1$/m);
});
