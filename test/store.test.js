import test from 'node:test';
import assert from 'node:assert/strict';
import { dayOf, todayUtc, daysAgoUtc } from '../src/db.js';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';

function freshStore() {
  return new Store(createSqliteDriver(':memory:'));
}

const REPO = {
  fullName: 'octo/hello',
  owner: 'octo',
  name: 'hello',
  private: false,
  description: 'A test repo',
  htmlUrl: 'https://github.com/octo/hello',
};

test('date helpers derive UTC days', () => {
  assert.equal(dayOf('2026-08-21T00:00:00Z'), '2026-08-21');
  assert.equal(todayUtc(new Date('2026-09-04T23:59:00Z')), '2026-09-04');
  assert.equal(daysAgoUtc(new Date('2026-09-04T10:00:00Z'), 3), '2026-09-01');
});

test('upsertRepo inserts once and updates metadata on repeat', async () => {
  const store = freshStore();
  const a = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  assert.equal(a.fullName, 'octo/hello');
  assert.equal(a.tracked, true);
  assert.equal(a.addedAt, '2026-09-01T00:00:00Z');

  const b = await store.upsertRepo({ ...REPO, description: 'Updated' }, '2026-09-02T00:00:00Z');
  assert.equal(b.id, a.id, 'same row');
  assert.equal(b.description, 'Updated');
  assert.equal(b.addedAt, '2026-09-01T00:00:00Z', 'addedAt is not overwritten');
  assert.equal(await store.countTrackedRepos(), 1);
});

test('untracking is a soft delete that preserves data and can be undone', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-08-30T00:00:00Z', count: 10, uniques: 4 },
  ], '2026-09-01T00:00:00Z');

  assert.equal(await store.untrackRepo('octo/hello', '2026-09-03T00:00:00Z'), true);
  assert.equal(await store.countTrackedRepos(), 0);
  assert.equal((await store.listRepos()).length, 0);
  assert.equal((await store.listRepos({ includeUntracked: true })).length, 1);
  assert.equal((await store.dailySeries(repo.id, 'views')).length, 1, 'history survives untracking');

  const back = await store.upsertRepo(REPO, '2026-09-05T00:00:00Z');
  assert.equal(back.tracked, true);
  assert.equal(back.id, repo.id);
  assert.equal((await store.dailySeries(repo.id, 'views'))[0].count, 10, 'history is restored with the repo');
});

test('ingestTrafficSeries never lowers a stored value', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');

  await store.ingestTrafficSeries(repo.id, 'clones', [
    { timestamp: '2026-09-01T00:00:00Z', count: 12, uniques: 5 },
  ], '2026-09-01T12:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'clones', [
    { timestamp: '2026-09-01T00:00:00Z', count: 3, uniques: 1 },
  ], '2026-09-01T18:00:00Z');

  const series = await store.dailySeries(repo.id, 'clones');
  assert.deepEqual(series, [{ day: '2026-09-01', count: 12, uniques: 5 }]);
});

test('ingestTrafficSeries raises a value and reports counts', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  const first = await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-09-01T00:00:00Z', count: 1, uniques: 1 },
    { timestamp: '2026-09-02T00:00:00Z', count: 2, uniques: 2 },
  ], '2026-09-02T00:00:00Z');
  assert.deepEqual(first, { rows: 2, raised: 2 });

  const second = await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-09-02T00:00:00Z', count: 9, uniques: 3 },
  ], '2026-09-02T06:00:00Z');
  assert.deepEqual(second, { rows: 1, raised: 1 });
  assert.deepEqual(await store.dailySeries(repo.id, 'views'), [
    { day: '2026-09-01', count: 1, uniques: 1 },
    { day: '2026-09-02', count: 9, uniques: 3 },
  ]);
});

test('ingestTrafficSeries reads existing days in a single query and writes in a single transaction', async () => {
  const store = freshStore();
  const driver = store.driver;
  await store.upsertRepo({ fullName: 'a/b', owner: 'a', name: 'b' }, '2026-01-01T00:00:00Z');
  const repo = await store.getRepo('a/b');

  let selects = 0;
  const realQuery = driver.query.bind(driver);
  driver.query = async (sql, params) => {
    if (/SELECT day, count, uniques FROM traffic_daily/.test(sql)) selects += 1;
    return realQuery(sql, params);
  };

  let transactions = 0;
  const realTransaction = driver.transaction.bind(driver);
  driver.transaction = async (statements) => {
    transactions += 1;
    return realTransaction(statements);
  };

  const points = Array.from({ length: 14 }, (_, i) => ({
    timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, count: i, uniques: i,
  }));
  const result = await store.ingestTrafficSeries(repo.id, 'views', points, '2026-01-15T00:00:00Z');

  assert.equal(selects, 1);
  assert.equal(transactions, 1);
  assert.deepEqual(result, { rows: 14, raised: 14 });
});

test('history outlives GitHub 14-day window', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-01-01T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-01-01T00:00:00Z', count: 5, uniques: 2 },
  ], '2026-01-01T00:00:00Z');
  // Six months later GitHub no longer reports January at all.
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-07-01T00:00:00Z', count: 7, uniques: 3 },
  ], '2026-07-01T00:00:00Z');

  assert.equal((await store.dailySeries(repo.id, 'views')).length, 2);
  assert.deepEqual(await store.totals(repo.id), {
    clones: 0, uniqueCloners: 0, views: 12, uniqueVisitors: 5,
  });
  assert.deepEqual(await store.coverage(repo.id), {
    firstDay: '2026-01-01', lastDay: '2026-07-01', days: 2,
  });
});

test('dailySeries and totals respect a since-day filter', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-08-01T00:00:00Z', count: 100, uniques: 10 },
    { timestamp: '2026-09-01T00:00:00Z', count: 5, uniques: 2 },
  ], '2026-09-01T00:00:00Z');

  assert.equal((await store.dailySeries(repo.id, 'views', '2026-08-15')).length, 1);
  assert.equal((await store.totals(repo.id, '2026-08-15')).views, 5);
  assert.equal((await store.totals(repo.id)).views, 105);
});

test('referrer snapshots keep one row per day and expose peak and first-seen', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestReferrers(repo.id, '2026-09-01', [
    { referrer: 'google.com', count: 10, uniques: 5 },
    { referrer: 'news.ycombinator.com', count: 40, uniques: 30 },
  ]);
  await store.ingestReferrers(repo.id, '2026-09-02', [
    { referrer: 'google.com', count: 12, uniques: 6 },
  ]);
  // Re-polling the same day replaces that day's snapshot rather than adding to it.
  await store.ingestReferrers(repo.id, '2026-09-02', [
    { referrer: 'google.com', count: 13, uniques: 6 },
  ]);

  const latest = await store.latestReferrers(repo.id, 10);
  assert.equal(latest.day, '2026-09-02');
  assert.deepEqual(latest.items, [
    { referrer: 'google.com', count: 13, uniques: 6, peakCount: 13, firstSeen: '2026-09-01' },
  ]);
  assert.equal((await store.referrerHistory(repo.id, 'news.ycombinator.com')).length, 1);
});

test('path snapshots behave the same and carry a title', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestPaths(repo.id, '2026-09-01', [
    { path: '/octo/hello', title: 'octo/hello: A test repo', count: 20, uniques: 9 },
  ]);
  const latest = await store.latestPaths(repo.id, 10);
  assert.equal(latest.day, '2026-09-01');
  assert.equal(latest.items[0].title, 'octo/hello: A test repo');
  assert.equal(latest.items[0].count, 20);
});

test('window snapshots record GitHub deduped 14-day figures', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestWindowSnapshot(repo.id, '2026-09-01', 'views', { count: 300, uniques: 42 });
  await store.ingestWindowSnapshot(repo.id, '2026-09-02', 'views', { count: 310, uniques: 45 });
  await store.ingestWindowSnapshot(repo.id, '2026-09-02', 'clones', { count: 20, uniques: 8 });
  assert.deepEqual(await store.latestWindow(repo.id), {
    day: '2026-09-02',
    views: { count: 310, uniques: 45 },
    clones: { count: 20, uniques: 8 },
  });
});

test('latestWindow is null when nothing has been polled yet', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  assert.equal(await store.latestWindow(repo.id), null);
});

test('latestWindow fills a missing kind with zeros on a partial snapshot', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestWindowSnapshot(repo.id, '2026-09-01', 'views', { count: 300, uniques: 42 });
  assert.deepEqual(await store.latestWindow(repo.id), {
    day: '2026-09-01',
    views: { count: 300, uniques: 42 },
    clones: { count: 0, uniques: 0 },
  });
});

test('markPolled records success and clears a previous error', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.markPolled(repo.id, { at: '2026-09-01T01:00:00Z', error: 'boom' });
  assert.equal((await store.getRepo('octo/hello')).lastError, 'boom');
  await store.markPolled(repo.id, { at: '2026-09-01T02:00:00Z' });
  const after = await store.getRepo('octo/hello');
  assert.equal(after.lastError, null);
  assert.equal(after.lastPolledAt, '2026-09-01T02:00:00Z');
});

test('repoSummaries returns one assembled record per tracked repo', async () => {
  const store = freshStore();
  const a = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  const b = await store.upsertRepo({ ...REPO, fullName: 'octo/quiet', name: 'quiet' }, '2026-09-01T00:00:00Z');
  await store.ingestTrafficSeries(a.id, 'views', [
    { timestamp: '2026-08-01T00:00:00Z', count: 100, uniques: 10 },
    { timestamp: '2026-09-01T00:00:00Z', count: 5, uniques: 2 },
  ], '2026-09-01T00:00:00Z');
  await store.ingestTrafficSeries(a.id, 'clones', [
    { timestamp: '2026-09-01T00:00:00Z', count: 3, uniques: 1 },
  ], '2026-09-01T00:00:00Z');

  const rows = await store.repoSummaries({ sinceDay: '2026-08-15', sparkSinceDay: '2026-08-25' });
  assert.equal(rows.length, 2);
  const hello = rows.find((r) => r.fullName === 'octo/hello');
  assert.deepEqual(hello.range, { clones: 3, uniqueCloners: 1, views: 5, uniqueVisitors: 2 });
  assert.deepEqual(hello.allTime, { clones: 3, uniqueCloners: 1, views: 105, uniqueVisitors: 12 });
  assert.equal(hello.coverage.firstDay, '2026-08-01');
  assert.deepEqual(hello.spark.days, ['2026-09-01']);
  assert.deepEqual(hello.spark.views, [5]);
  assert.deepEqual(hello.spark.clones, [3]);

  const quiet = rows.find((r) => r.fullName === 'octo/quiet');
  assert.deepEqual(quiet.allTime, { clones: 0, uniqueCloners: 0, views: 0, uniqueVisitors: 0 });
  assert.deepEqual(quiet.spark.days, []);
});

test('repoSummaries gives every repo its own totals objects', async () => {
  const store = freshStore();
  await store.upsertRepo({ ...REPO, fullName: 'octo/a', name: 'a' }, '2026-09-01T00:00:00Z');
  await store.upsertRepo({ ...REPO, fullName: 'octo/b', name: 'b' }, '2026-09-01T00:00:00Z');
  const [a, b] = await store.repoSummaries({});
  assert.notEqual(a.allTime, b.allTime, 'separate repos do not share one totals object');
  assert.notEqual(a.allTime, a.range, 'allTime and range are not the same object');
  a.allTime.views = 99;
  assert.equal(b.allTime.views, 0, 'mutating one summary does not affect another');
});

test('repoSummaries defaults spark to empty arrays when sparkSinceDay is omitted', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-09-01T00:00:00Z', count: 5, uniques: 2 },
  ], '2026-09-01T00:00:00Z');

  const rows = await store.repoSummaries({});
  assert.deepEqual(rows[0].spark, { days: [], views: [], clones: [] });
});

test('repoSummaries spark zero-fills a kind with no row on a given day', async () => {
  const store = freshStore();
  const repo = await store.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-09-01T00:00:00Z', count: 5, uniques: 2 },
  ], '2026-09-01T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'clones', [
    { timestamp: '2026-09-02T00:00:00Z', count: 7, uniques: 3 },
  ], '2026-09-02T00:00:00Z');

  const rows = await store.repoSummaries({ sparkSinceDay: '2026-09-01' });
  const spark = rows[0].spark;
  assert.deepEqual(spark.days, ['2026-09-01', '2026-09-02']);
  assert.deepEqual(spark.views, [5, 0], 'no views row on 09-02 is zero, not missing');
  assert.deepEqual(spark.clones, [0, 7], 'no clones row on 09-01 is zero, not missing');
});

test('meta is a simple key/value store', async () => {
  const store = freshStore();
  assert.equal(await store.getMeta('seeded_at'), null);
  await store.setMeta('seeded_at', '2026-09-04T00:00:00Z');
  assert.equal(await store.getMeta('seeded_at'), '2026-09-04T00:00:00Z');
  await store.setMeta('seeded_at', 'later');
  assert.equal(await store.getMeta('seeded_at'), 'later');
});

test('poll runs are recorded and the latest is retrievable', async () => {
  const store = freshStore();
  assert.equal(await store.lastPollRun(), null);
  const id = await store.startPollRun('2026-09-04T00:00:00Z');
  await store.finishPollRun(id, { total: 3, ok: 2, failed: 1, at: '2026-09-04T00:01:00Z' });
  assert.deepEqual(await store.lastPollRun(), {
    id, startedAt: '2026-09-04T00:00:00Z', finishedAt: '2026-09-04T00:01:00Z',
    total: 3, ok: 2, failed: 1,
  });
});

test('the schema persists across reopening the same file', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gha-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.db');

  const s1 = new Store(createSqliteDriver(file));
  const repo = await s1.upsertRepo(REPO, '2026-09-01T00:00:00Z');
  await s1.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-09-01T00:00:00Z', count: 4, uniques: 2 },
  ], '2026-09-01T00:00:00Z');
  await s1.close();

  const s2 = new Store(createSqliteDriver(file));
  assert.equal(await s2.countTrackedRepos(), 1);
  assert.equal((await s2.dailySeries((await s2.getRepo('octo/hello')).id, 'views'))[0].count, 4);
  await s2.close();
});

test('the poll lock is exclusive and expires', async () => {
  const store = freshStore();
  assert.equal(await store.acquirePollLock('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'), true);
  assert.equal(await store.acquirePollLock('2026-01-01T00:30:00Z', '2026-01-01T01:30:00Z'), false);
  // A crashed run must not wedge polling forever: an expired lock is stolen.
  assert.equal(await store.acquirePollLock('2026-01-01T02:00:00Z', '2026-01-01T03:00:00Z'), true);
  await store.releasePollLock('2026-01-01T03:00:00Z');
  assert.equal(await store.acquirePollLock('2026-01-01T02:05:00Z', '2026-01-01T03:05:00Z'), true);
});

test('releasePollLock frees the lock when the expiry matches the current holder', async () => {
  const store = freshStore();
  assert.equal(await store.acquirePollLock('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'), true);
  await store.releasePollLock('2026-01-01T01:00:00Z');
  // Freed: an acquire well before the original expiry now succeeds.
  assert.equal(await store.acquirePollLock('2026-01-01T00:10:00Z', '2026-01-01T01:10:00Z'), true);
});

test('releasePollLock does nothing when the expiry does not match the current holder', async () => {
  const store = freshStore();
  assert.equal(await store.acquirePollLock('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'), true);
  await store.releasePollLock('some-other-expiry');
  // Still held: an acquire before the real expiry is denied, exactly as if
  // release had never been called.
  assert.equal(await store.acquirePollLock('2026-01-01T00:10:00Z', '2026-01-01T01:10:00Z'), false);
});

test('a stale holder cannot release a lock a later run has legitimately stolen', async () => {
  const store = freshStore();
  // Run A acquires with expiry E1, then overruns past E1 without ever
  // seeing its own release fire in time.
  assert.equal(await store.acquirePollLock('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'), true); // A: E1 = 01:00
  // Run B ticks in after E1 has passed and legitimately steals the lock.
  assert.equal(await store.acquirePollLock('2026-01-01T01:30:00Z', '2026-01-01T02:30:00Z'), true); // B: E2 = 02:30
  // A finally runs late and tries to release using ITS OWN (stale) expiry.
  await store.releasePollLock('2026-01-01T01:00:00Z');
  // B's lock must still be held: an acquire attempt before E2 is denied.
  assert.equal(await store.acquirePollLock('2026-01-01T01:45:00Z', '2026-01-01T02:45:00Z'), false);
});

test('listDueRepos puts never-polled repos first, then the stalest', async () => {
  const store = freshStore();
  for (const [name, polledAt] of [['a/one', '2026-01-03T00:00:00Z'], ['a/two', null], ['a/three', '2026-01-01T00:00:00Z']]) {
    await store.upsertRepo({ fullName: name, owner: 'a', name: name.split('/')[1] }, '2026-01-01T00:00:00Z');
    const repo = await store.getRepo(name);
    if (polledAt) await store.markPolled(repo.id, { at: polledAt });
  }
  const due = await store.listDueRepos(2);
  assert.deepEqual(due.map((r) => r.fullName), ['a/two', 'a/three']);
});
