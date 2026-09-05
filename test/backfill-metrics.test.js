import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';
import { dailyCountsFromTimestamps, backfillRepo } from '../bin/backfill-metrics.js';

test('timestamps become a cumulative daily series with gaps filled', () => {
  const series = dailyCountsFromTimestamps(
    ['2026-01-01T10:00:00Z', '2026-01-01T18:00:00Z', '2026-01-04T09:00:00Z'],
    { upTo: '2026-01-05' },
  );
  assert.deepEqual(series, [
    { day: '2026-01-01', count: 2 },
    { day: '2026-01-02', count: 2 },
    { day: '2026-01-03', count: 2 },
    { day: '2026-01-04', count: 3 },
    { day: '2026-01-05', count: 3 },
  ]);
});

test('an empty list produces an empty series', () => {
  assert.deepEqual(dailyCountsFromTimestamps([], { upTo: '2026-01-05' }), []);
});

test('timestamps are not assumed to arrive in order', () => {
  const series = dailyCountsFromTimestamps(
    ['2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z'],
    { upTo: '2026-01-03' },
  );
  assert.deepEqual(series.map((s) => s.count), [1, 1, 2]);
});

test('a timestamp after upTo is ignored rather than extending the series', () => {
  const series = dailyCountsFromTimestamps(
    ['2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'],
    { upTo: '2026-01-02' },
  );
  assert.deepEqual(series, [{ day: '2026-01-01', count: 1 }, { day: '2026-01-02', count: 1 }]);
});

test('a day the poller already recorded is never overwritten', async () => {
  const store = new Store(createSqliteDriver(':memory:'));
  await store.upsertRepo({ fullName: 'a/b', owner: 'a', name: 'b' }, '2026-01-01T00:00:00Z');
  const repo = await store.getRepo('a/b');
  // A real reading from the poller, complete with a watcher count.
  await store.recordRepoMetrics(repo.id, '2026-01-02', { stars: 99, forks: 9, watchers: 5 }, '2026-01-02T00:00:00Z');

  const client = {
    listStargazerDates: async () => ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'],
    listForkDates: async () => [],
  };
  await backfillRepo({ store, client, repo: { ...repo, fullName: 'a/b' }, upTo: '2026-01-02' });

  const latest = await store.latestMetrics(repo.id);
  assert.deepEqual(latest, { day: '2026-01-02', stars: 99, forks: 9, watchers: 5 });
  assert.equal((await store.metricsSeries(repo.id, null)).length, 2);
});

test('a day present in the star series but not the fork series carries the fork count forward', async () => {
  const store = new Store(createSqliteDriver(':memory:'));
  await store.upsertRepo({ fullName: 'c/d', owner: 'c', name: 'd' }, '2026-01-01T00:00:00Z');
  const repo = await store.getRepo('c/d');

  const client = {
    listStargazerDates: async () => ['2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'],
    listForkDates: async () => ['2026-01-01T00:00:00Z'],
  };
  const result = await backfillRepo({ store, client, repo: { ...repo, fullName: 'c/d' }, upTo: '2026-01-03' });

  assert.equal(result.days, 3);
  const series = await store.metricsSeries(repo.id, null);
  assert.deepEqual(series, [
    { day: '2026-01-01', stars: 1, forks: 1, watchers: null },
    { day: '2026-01-02', stars: 1, forks: 1, watchers: null },
    { day: '2026-01-03', stars: 2, forks: 1, watchers: null },
  ]);
});
