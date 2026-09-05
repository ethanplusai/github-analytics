import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';
import { migrate, verify } from '../bin/migrate.js';

function freshStore() {
  return new Store(createSqliteDriver(':memory:'));
}

async function seed(store) {
  await store.upsertRepo({ fullName: 'a/b', owner: 'a', name: 'b', private: true }, '2026-01-01T00:00:00Z');
  const repo = await store.getRepo('a/b');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-01-01T00:00:00Z', count: 10, uniques: 4 },
    { timestamp: '2026-01-02T00:00:00Z', count: 20, uniques: 9 },
  ], '2026-01-02T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'clones', [
    { timestamp: '2026-01-02T00:00:00Z', count: 3, uniques: 2 },
  ], '2026-01-02T00:00:00Z');
  await store.ingestWindowSnapshot(repo.id, '2026-01-02', 'views', { count: 30, uniques: 13 });
  await store.ingestReferrers(repo.id, '2026-01-02', [{ referrer: 'g.com', count: 2, uniques: 1 }]);
  await store.ingestPaths(repo.id, '2026-01-02', [{ path: '/readme', title: 'README', count: 5, uniques: 2 }]);
  await store.markPolled(repo.id, { at: '2026-01-03T00:00:00Z', error: null });
  return repo;
}

test('migrate copies every table and verifies totals', async () => {
  const source = new Store(createSqliteDriver(':memory:'));
  await source.upsertRepo({ fullName: 'a/b', owner: 'a', name: 'b', private: true }, '2026-01-01T00:00:00Z');
  const repo = await source.getRepo('a/b');
  await source.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-01-01T00:00:00Z', count: 10, uniques: 4 },
  ], '2026-01-01T00:00:00Z');
  await source.ingestReferrers(repo.id, '2026-01-01', [{ referrer: 'g.com', count: 2, uniques: 1 }]);

  const target = new Store(createSqliteDriver(':memory:'));
  const result = await migrate({ from: source, to: target, log: () => {} });

  assert.deepEqual(result.mismatches, []);
  assert.equal(result.repos, 1);
  const copied = await target.getRepo('a/b');
  assert.deepEqual(await target.totals(copied.id, null), await source.totals(repo.id, null));
});

test('migrate carries traffic, snapshots, referrers, paths and poll state, remapped through full_name', async () => {
  const source = freshStore();
  const repo = await seed(source);

  const target = freshStore();
  const result = await migrate({ from: source, to: target, log: () => {} });

  assert.equal(result.repos, 1);
  assert.equal(result.trafficRows, 3);
  assert.deepEqual(result.mismatches, []);

  const copied = await target.getRepo('a/b');
  assert.equal(typeof copied.id, 'number'); // target assigns its own id, never the source's
  assert.equal(copied.fullName, 'a/b');
  assert.equal(copied.private, true);
  assert.equal(copied.tracked, true);
  assert.equal(copied.lastPolledAt, '2026-01-03T00:00:00Z');

  assert.deepEqual(await target.dailySeries(copied.id, 'views', null), await source.dailySeries(repo.id, 'views', null));
  assert.deepEqual(await target.dailySeries(copied.id, 'clones', null), await source.dailySeries(repo.id, 'clones', null));
  assert.deepEqual(await target.latestWindow(copied.id), await source.latestWindow(repo.id));
  assert.deepEqual(await target.latestReferrers(copied.id, 10), await source.latestReferrers(repo.id, 10));
  assert.deepEqual(await target.latestPaths(copied.id, 10), await source.latestPaths(repo.id, 10));
  assert.deepEqual(await target.totals(copied.id, null), await source.totals(repo.id, null));
  assert.deepEqual(await target.coverage(copied.id), await source.coverage(repo.id));

  // poll_runs is deliberately not copied — operational history, not traffic data.
  assert.equal(await target.lastPollRun(), null);
});

test('migrate carries untracked repos and their untracked_at', async () => {
  const source = freshStore();
  await seed(source);
  const now = '2026-01-04T00:00:00Z';
  await source.untrackRepo('a/b', now);

  const target = freshStore();
  const result = await migrate({ from: source, to: target, log: () => {} });

  assert.equal(result.repos, 1);
  assert.deepEqual(result.mismatches, []);

  const copied = await target.getRepo('a/b');
  assert.equal(copied.tracked, false);
  assert.equal(copied.untrackedAt, now);
});

test('migrate is safe to run twice', async () => {
  const source = freshStore();
  const repo = await seed(source);

  const target = freshStore();
  await migrate({ from: source, to: target, log: () => {} });
  const copied = await target.getRepo('a/b');
  const totalsAfterFirst = await target.totals(copied.id, null);
  const coverageAfterFirst = await target.coverage(copied.id);

  const second = await migrate({ from: source, to: target, log: () => {} });

  assert.deepEqual(second.mismatches, []);
  const copiedAgain = await target.getRepo('a/b');
  assert.equal(copiedAgain.id, copied.id, 'repos upsert on full_name, not a new row');
  assert.deepEqual(await target.totals(copiedAgain.id, null), totalsAfterFirst);
  assert.deepEqual(await target.coverage(copiedAgain.id), coverageAfterFirst);
  assert.deepEqual(await target.latestReferrers(copiedAgain.id, 10), await source.latestReferrers(repo.id, 10));
  assert.deepEqual(await target.latestPaths(copiedAgain.id, 10), await source.latestPaths(repo.id, 10));
});

test('migrate reports a mismatch when the copy diverges from the source', async () => {
  const source = freshStore();
  const repo = await seed(source);

  const target = freshStore();
  await migrate({ from: source, to: target, log: () => {} });

  // Corrupt the copy directly, bypassing migrate, to prove verification
  // actually compares rather than trusting the copy step.
  const copied = await target.getRepo('a/b');
  await target.ingestTrafficSeries(copied.id, 'views', [
    { timestamp: '2026-01-05T00:00:00Z', count: 999, uniques: 999 },
  ], '2026-01-05T00:00:00Z');

  const result = await migrate({ from: source, to: target, log: () => {} });
  assert.ok(result.mismatches.length > 0);
  assert.ok(result.mismatches.every((m) => m.repo === 'a/b'));
});

test('verify catches a snapshot row that went missing from the target without re-copying over it', async () => {
  const source = freshStore();
  await seed(source);

  const target = freshStore();
  await migrate({ from: source, to: target, log: () => {} });

  // Delete a referrer snapshot row directly from the target, bypassing
  // migrate() entirely, to prove verify() actually reads the target back
  // rather than trusting that migrate() put everything there.
  const copied = await target.getRepo('a/b');
  await target.driver.run(
    'DELETE FROM referrer_snapshots WHERE repo_id = ? AND day = ? AND referrer = ?',
    [copied.id, '2026-01-02', 'g.com'],
  );

  // A plain re-run of migrate() would silently repair this (ingestReferrers
  // replaces the whole day), so verification must be callable on its own,
  // against the copy as it actually stands.
  const result = await verify({ from: source, to: target, log: () => {} });

  assert.ok(result.mismatches.length > 0);
  assert.ok(result.mismatches.every((m) => m.repo === 'a/b'));
  assert.ok(result.mismatches.some((m) => m.field === 'referrers'));
});

test('verify catches a repo entirely absent from the target', async () => {
  const source = freshStore();
  await seed(source);
  const target = freshStore();

  const result = await verify({ from: source, to: target, log: () => {} });
  assert.ok(result.mismatches.length > 0);
  assert.ok(result.mismatches.some((m) => m.repo === 'a/b' && m.field === 'presence'));
});
