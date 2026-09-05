import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';
import { Poller, isStale } from '../src/poller.js';
import { GitHubError } from '../src/github.js';

function fakeClient(overrides = {}) {
  return {
    listOwnedRepos: async () => [],
    getClones: async () => ({ count: 0, uniques: 0, points: [] }),
    getViews: async () => ({ count: 0, uniques: 0, points: [] }),
    getReferrers: async () => [],
    getPaths: async () => [],
    ...overrides,
  };
}

function setup(clientOverrides = {}, opts = {}) {
  const store = new Store(createSqliteDriver(':memory:'));
  const client = fakeClient(clientOverrides);
  const poller = new Poller({
    store, client, now: () => new Date('2026-09-04T12:00:00Z'), concurrency: 2, ...opts,
  });
  return { store, client, poller };
}

test('isStale is true for a never-polled repo and for one polled long ago', () => {
  const now = new Date('2026-09-04T12:00:00Z');
  assert.equal(isStale({ lastPolledAt: null }, now, 6), true);
  assert.equal(isStale({ lastPolledAt: '2026-09-04T11:00:00Z' }, now, 6), false);
  assert.equal(isStale({ lastPolledAt: '2026-09-04T02:00:00Z' }, now, 6), true);
});

test('pollRepo writes all four datasets and the window snapshot', async () => {
  const { store, poller } = setup({
    getClones: async () => ({
      count: 30, uniques: 12,
      points: [{ timestamp: '2026-09-03T00:00:00Z', count: 4, uniques: 2 }],
    }),
    getViews: async () => ({
      count: 90, uniques: 40,
      points: [{ timestamp: '2026-09-03T00:00:00Z', count: 11, uniques: 6 }],
    }),
    getReferrers: async () => [{ referrer: 'google.com', count: 8, uniques: 5 }],
    getPaths: async () => [{ path: '/octo/hello', title: 'Overview', count: 20, uniques: 9 }],
  });
  const repo = await store.upsertRepo({
    fullName: 'octo/hello', owner: 'octo', name: 'hello', private: false,
    description: null, htmlUrl: null,
  }, '2026-09-01T00:00:00Z');

  const result = await poller.pollRepo(repo);
  assert.deepEqual(result, { fullName: 'octo/hello', ok: true, error: null });

  assert.deepEqual(await store.dailySeries(repo.id, 'clones'), [{ day: '2026-09-03', count: 4, uniques: 2 }]);
  assert.deepEqual(await store.dailySeries(repo.id, 'views'), [{ day: '2026-09-03', count: 11, uniques: 6 }]);
  assert.equal((await store.latestReferrers(repo.id, 10)).items[0].referrer, 'google.com');
  assert.equal((await store.latestPaths(repo.id, 10)).items[0].path, '/octo/hello');
  assert.deepEqual(await store.latestWindow(repo.id), {
    day: '2026-09-04',
    views: { count: 90, uniques: 40 },
    clones: { count: 30, uniques: 12 },
  });
  assert.equal((await store.getRepo('octo/hello')).lastPolledAt, '2026-09-04T12:00:00.000Z');
  assert.equal((await store.getRepo('octo/hello')).lastError, null);
});

test('pollRepo records a readable error and does not throw', async () => {
  const { store, poller } = setup({
    getClones: async () => { throw new GitHubError('Must have push access', { status: 403, kind: 'forbidden' }); },
  });
  const repo = await store.upsertRepo({
    fullName: 'octo/nope', owner: 'octo', name: 'nope', private: false, description: null, htmlUrl: null,
  }, '2026-09-01T00:00:00Z');

  const result = await poller.pollRepo(repo);
  assert.equal(result.ok, false);
  assert.match(result.error, /push access/);
  assert.match((await store.getRepo('octo/nope')).lastError, /push access/);
});

test('pollAll keeps going when one repo fails and reports a tally', async () => {
  const { store, poller } = setup({
    getViews: async (fullName) => {
      if (fullName === 'octo/bad') throw new GitHubError('Not Found', { status: 404, kind: 'not_found' });
      return { count: 1, uniques: 1, points: [{ timestamp: '2026-09-03T00:00:00Z', count: 1, uniques: 1 }] };
    },
  });
  for (const name of ['good1', 'bad', 'good2']) {
    await store.upsertRepo({
      fullName: `octo/${name}`, owner: 'octo', name, private: false, description: null, htmlUrl: null,
    }, '2026-09-01T00:00:00Z');
  }

  const summary = await poller.pollAll();
  assert.equal(summary.total, 3);
  assert.equal(summary.ok, 2);
  assert.equal(summary.failed, 1);
  assert.equal((await store.lastPollRun()).failed, 1);
  assert.equal(poller.getState().running, false);
  assert.equal(poller.getState().lastResult.failed, 1);
});

test('pollAll aborts the remainder when the rate limit is hit', async () => {
  let seen = 0;
  const { store, poller } = setup({
    getClones: async () => {
      seen += 1;
      throw new GitHubError('API rate limit exceeded', { status: 403, kind: 'rate_limit' });
    },
  }, { concurrency: 1 });
  for (const name of ['a', 'b', 'c', 'd']) {
    await store.upsertRepo({
      fullName: `octo/${name}`, owner: 'octo', name, private: false, description: null, htmlUrl: null,
    }, '2026-09-01T00:00:00Z');
  }
  const summary = await poller.pollAll();
  assert.ok(seen < 4, `stopped early, saw ${seen}`);
  assert.equal(summary.aborted, 'rate_limit');
});

test('pollAll refuses to run twice concurrently', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store, poller } = setup({ getClones: async () => { await gate; return { count: 0, uniques: 0, points: [] }; } });
  await store.upsertRepo({
    fullName: 'octo/a', owner: 'octo', name: 'a', private: false, description: null, htmlUrl: null,
  }, '2026-09-01T00:00:00Z');

  const first = poller.pollAll();
  const second = await poller.pollAll();
  assert.equal(second.skipped, 'already_running');
  release();
  await first;
});

test('seedFromGitHub adds only repos with traffic access', async () => {
  const { store, poller } = setup({
    listOwnedRepos: async () => [
      { fullName: 'octo/yes', owner: 'octo', name: 'yes', private: false, description: 'a', htmlUrl: 'u', pushedAt: '2026-09-01T00:00:00Z', canReadTraffic: true },
      { fullName: 'octo/no', owner: 'octo', name: 'no', private: false, description: null, htmlUrl: 'u', pushedAt: '2026-09-01T00:00:00Z', canReadTraffic: false },
    ],
  });
  const result = await poller.seedFromGitHub();
  assert.deepEqual(result, { added: 1, skipped: 1, total: 2 });
  assert.deepEqual((await store.listRepos()).map((r) => r.fullName), ['octo/yes']);
  assert.equal(await store.getMeta('seeded_at'), '2026-09-04T12:00:00.000Z');
});

test('seedFromGitHub raises state.seeding for its duration, on every caller', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { poller } = setup({ listOwnedRepos: async () => { await gate; return []; } });

  assert.equal(poller.getState().seeding, false);
  const p = poller.seedFromGitHub();
  assert.equal(poller.getState().seeding, true, 'raised for a direct call, not just through bootstrap');
  release();
  await p;
  assert.equal(poller.getState().seeding, false);
});

test('seedFromGitHub refuses to run twice concurrently', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { poller } = setup({ listOwnedRepos: async () => { await gate; return []; } });

  const first = poller.seedFromGitHub();
  const second = await poller.seedFromGitHub();
  assert.equal(second.skipped, 'already_running');
  release();
  await first;
  assert.equal(poller.getState().seeding, false, 'the flag is released once the in-flight seed finishes');
});

test('seedFromGitHub does not resurrect a repo the user untracked', async () => {
  const { store, poller } = setup({
    listOwnedRepos: async () => [
      { fullName: 'octo/yes', owner: 'octo', name: 'yes', private: false, description: null, htmlUrl: 'u', pushedAt: null, canReadTraffic: true },
    ],
  });
  await poller.seedFromGitHub();
  await store.untrackRepo('octo/yes', '2026-09-04T13:00:00Z');
  await poller.seedFromGitHub();
  assert.equal(await store.countTrackedRepos(), 0, 'a deliberate removal is respected');
});

test('bootstrap seeds then polls on an empty database', async () => {
  const { store, poller } = setup({
    listOwnedRepos: async () => [
      { fullName: 'octo/yes', owner: 'octo', name: 'yes', private: false, description: null, htmlUrl: 'u', pushedAt: null, canReadTraffic: true },
    ],
    getViews: async () => ({ count: 3, uniques: 1, points: [{ timestamp: '2026-09-03T00:00:00Z', count: 3, uniques: 1 }] }),
  });
  const result = await poller.bootstrap({ autoSeed: true });
  assert.equal(result.seeded.added, 1);
  assert.equal(result.polled.ok, 1);
  const yesRepo = await store.getRepo('octo/yes');
  assert.equal((await store.dailySeries(yesRepo.id, 'views'))[0].count, 3);
});

test('bootstrap skips the poll when nothing is stale', async () => {
  const { store, poller } = setup();
  const repo = await store.upsertRepo({
    fullName: 'octo/a', owner: 'octo', name: 'a', private: false, description: null, htmlUrl: null,
  }, '2026-09-01T00:00:00Z');
  await store.markPolled(repo.id, { at: '2026-09-04T11:00:00Z' });
  await store.setMeta('seeded_at', '2026-09-01T00:00:00Z');

  const result = await poller.bootstrap({ autoSeed: true });
  assert.equal(result.seeded, null, 'already seeded');
  assert.equal(result.polled, null, 'nothing stale');
});

test('a poller with no client reports that instead of crashing', async () => {
  const store = new Store(createSqliteDriver(':memory:'));
  const poller = new Poller({ store, client: null, now: () => new Date('2026-09-04T12:00:00Z') });
  const result = await poller.bootstrap({ autoSeed: true });
  assert.equal(result.error, 'no_token');
  assert.equal((await poller.pollAll()).skipped, 'no_token');
});

test('a store failure during pollAll releases the running flag instead of wedging the poller', async () => {
  const { store, poller } = setup();
  await store.upsertRepo({
    fullName: 'octo/a', owner: 'octo', name: 'a', private: false, description: null, htmlUrl: null,
  }, '2026-09-01T00:00:00Z');

  const original = store.startPollRun.bind(store);
  let failNext = true;
  store.startPollRun = (...args) => {
    if (failNext) { failNext = false; throw new Error('SQLITE_BUSY'); }
    return original(...args);
  };

  await assert.rejects(() => poller.pollAll(), /SQLITE_BUSY/);
  assert.equal(poller.getState().running, false, 'the flag is released even when the run throws');

  const after = await poller.pollAll();
  assert.notEqual(after.skipped, 'already_running', 'a later poll is not permanently blocked');
});

test('bootstrap does not throw when the polling phase fails', async () => {
  const { store, poller } = setup();
  await store.upsertRepo({
    fullName: 'octo/a', owner: 'octo', name: 'a', private: false, description: null, htmlUrl: null,
  }, '2026-09-01T00:00:00Z');
  await store.setMeta('seeded_at', '2026-09-01T00:00:00Z');
  poller.pollAll = async () => { throw new Error('boom'); };

  const result = await poller.bootstrap({ autoSeed: true });
  assert.ok(result, 'bootstrap returned rather than throwing');
  assert.equal(result.seeded, null, 'already seeded, so seeding is skipped');
  assert.deepEqual(result.polled, { error: 'boom' }, 'polling failure is captured in the same shape as a seeding failure');
  assert.equal(result.error, null, 'the top-level error field is reserved for no_token');
});

test('pollDue stops starting repos once the deadline passes', async () => {
  const { store, poller } = setup();
  for (const name of ['a/1', 'a/2', 'a/3', 'a/4', 'a/5']) {
    await store.upsertRepo({ fullName: name, owner: 'a', name: name.slice(2) }, '2026-01-01T00:00:00Z');
  }

  // Each simulated poll costs 1s against a 2.5s budget, so exactly three start.
  let elapsed = 0;
  poller.pollRepo = async (repo) => { elapsed += 1000; return { fullName: repo.fullName, ok: true }; };
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + elapsed;
  try {
    const result = await poller.pollDue({ limit: 5, deadlineMs: 2500 });
    assert.equal(result.total, 3);
    assert.equal(result.ok, 3);
    assert.equal(result.remaining, 2);
  } finally {
    Date.now = realNow;
  }
});

test('pollDue takes the stalest repos first', async () => {
  const { store, poller } = setup();
  for (const [name, at] of [['a/fresh', '2026-09-04T11:00:00Z'], ['a/stale', '2026-01-01T00:00:00Z']]) {
    await store.upsertRepo({ fullName: name, owner: 'a', name: name.slice(2) }, '2026-01-01T00:00:00Z');
    const repo = await store.getRepo(name);
    await store.markPolled(repo.id, { at });
  }
  const polled = [];
  poller.pollRepo = async (repo) => { polled.push(repo.fullName); return { fullName: repo.fullName, ok: true }; };
  await poller.pollDue({ limit: 1, deadlineMs: 60000 });
  assert.deepEqual(polled, ['a/stale']);
});

// Regression: pollDue() previously never recorded a poll run, so a
// cron-only deployment (no interval timer) would report "Updated never"
// forever even while polling was working perfectly — store.lastPollRun()
// stayed null across restarts because nothing but pollAll() ever wrote one.
test('pollDue records a poll run whose totals match its return value', async () => {
  const { store, poller } = setup();
  for (const name of ['a/1', 'a/2', 'a/3']) {
    await store.upsertRepo({ fullName: name, owner: 'a', name: name.slice(2) }, '2026-01-01T00:00:00Z');
  }
  let n = 0;
  poller.pollRepo = async (repo) => {
    n += 1;
    return n === 2 ? { fullName: repo.fullName, ok: false } : { fullName: repo.fullName, ok: true };
  };

  const result = await poller.pollDue({ limit: 10, deadlineMs: 60000 });
  assert.deepEqual(result, { total: 3, ok: 2, failed: 1, remaining: 0 });

  const persisted = await store.lastPollRun();
  assert.ok(persisted, 'a poll run was persisted');
  assert.equal(persisted.total, result.total);
  assert.equal(persisted.ok, result.ok);
  assert.equal(persisted.failed, result.failed);
  assert.ok(persisted.startedAt, 'startedAt was recorded');
  assert.ok(persisted.finishedAt, 'finishedAt was recorded');

  // The in-memory state matches the persisted path too, so a process that
  // never restarts also sees the run reflected immediately.
  const state = poller.getState();
  assert.equal(state.lastRunAt, persisted.finishedAt);
  assert.deepEqual(state.lastResult, {
    total: result.total, ok: result.ok, failed: result.failed,
    startedAt: persisted.startedAt, finishedAt: persisted.finishedAt,
  });
});

test('pollDue still records a poll run when a repo poll throws', async () => {
  const { store, poller } = setup();
  await store.upsertRepo({ fullName: 'a/1', owner: 'a', name: '1' }, '2026-01-01T00:00:00Z');
  poller.pollRepo = async () => { throw new Error('boom'); };

  await assert.rejects(() => poller.pollDue({ limit: 10, deadlineMs: 60000 }), /boom/);

  const persisted = await store.lastPollRun();
  assert.ok(persisted, 'a poll run was persisted even though pollRepo threw');
  assert.ok(persisted.finishedAt, 'finishedAt was recorded despite the throw');
});
