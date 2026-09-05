import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';
import { createApi, resolveRange } from '../src/api.js';
import { sendError } from '../src/http.js';

const NOW = new Date('2026-09-04T12:00:00Z');

function stubPoller(over = {}) {
  return {
    getState: () => ({ running: false, total: 0, done: 0, failed: 0, currentRepo: null, lastRunAt: null, lastResult: null }),
    pollRepo: async (repo) => ({ fullName: repo.fullName, ok: true, error: null }),
    pollAll: async () => ({ total: 0, ok: 0, failed: 0 }),
    pollDue: async () => ({ total: 0, ok: 0, failed: 0, remaining: 0 }),
    seedFromGitHub: async () => ({ added: 0, skipped: 0, total: 0 }),
    ...over,
  };
}

async function withApi({
  storeSetup = () => {}, poller = stubPoller(), client = null,
  tokenInfo = { token: 't', source: 'test', login: 'octo' },
  config = { pollIntervalHours: 6, dbPath: '/tmp/x.db' },
} = {}, fn) {
  const store = new Store(createSqliteDriver(':memory:'));
  await storeSetup(store);
  const router = createApi({
    store, poller, client, tokenInfo,
    config,
    version: '1.0.0', now: () => NOW,
  });
  const server = createServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    sendError(res, 404, 'not_found', 'no route');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, store); } finally { await new Promise((r) => server.close(r)); }
}

async function seedRepo(store, fullName = 'octo/hello') {
  const [owner, name] = fullName.split('/');
  const repo = await store.upsertRepo({
    fullName, owner, name, private: false, description: 'A test repo',
    htmlUrl: `https://github.com/${fullName}`,
  }, '2026-01-01T00:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'views', [
    { timestamp: '2026-01-01T00:00:00Z', count: 100, uniques: 20 },
    { timestamp: '2026-09-03T00:00:00Z', count: 7, uniques: 3 },
  ], '2026-09-04T12:00:00Z');
  await store.ingestTrafficSeries(repo.id, 'clones', [
    { timestamp: '2026-09-03T00:00:00Z', count: 4, uniques: 2 },
  ], '2026-09-04T12:00:00Z');
  await store.ingestWindowSnapshot(repo.id, '2026-09-04', 'views', { count: 7, uniques: 3 });
  await store.ingestWindowSnapshot(repo.id, '2026-09-04', 'clones', { count: 4, uniques: 2 });
  await store.ingestReferrers(repo.id, '2026-09-04', [{ referrer: 'google.com', count: 5, uniques: 3 }]);
  await store.ingestPaths(repo.id, '2026-09-04', [{ path: '/octo/hello', title: 'Overview', count: 9, uniques: 4 }]);
  await store.markPolled(repo.id, { at: '2026-09-04T12:00:00Z' });
  return repo;
}

test('resolveRange maps presets and defaults to all', () => {
  // Each preset is inclusive of today, so range=30 starts 29 days back.
  assert.deepEqual(resolveRange('30', NOW), { range: '30', sinceDay: '2026-08-06' });
  assert.deepEqual(resolveRange('90', NOW), { range: '90', sinceDay: '2026-06-07' });
  assert.deepEqual(resolveRange('365', NOW), { range: '365', sinceDay: '2025-09-05' });
  assert.deepEqual(resolveRange('all', NOW), { range: 'all', sinceDay: null });
  assert.deepEqual(resolveRange(undefined, NOW), { range: 'all', sinceDay: null });
  assert.deepEqual(resolveRange('bogus', NOW), { range: 'all', sinceDay: null });
});

test('resolveRange does not resolve inherited Object.prototype keys', () => {
  // RANGE_DAYS is a plain object literal; `range=toString` must not resolve
  // to Function.prototype.toString via the prototype chain and blow up
  // `days - 1` into NaN. It should fall back to the documented "all" case,
  // exactly like any other unrecognised value.
  assert.deepEqual(resolveRange('toString', NOW), { range: 'all', sinceDay: null });
  assert.deepEqual(resolveRange('constructor', NOW), { range: 'all', sinceDay: null });
});

test('GET /api/health', async () => {
  await withApi({}, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  });
});

test('GET /api/status reports token, repo count, and poll state', async () => {
  await withApi({ storeSetup: (s) => seedRepo(s) }, async (base) => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.equal(body.version, '1.0.0');
    assert.deepEqual(body.token, { present: true, source: 'test', login: 'octo' });
    assert.equal(body.repoCount, 1);
    assert.equal(body.pollIntervalHours, 6);
    assert.equal(body.poll.running, false);
  });
});

test('GET /api/status falls back to the persisted poll run after a restart', async () => {
  // A fresh process has an empty in-memory poller state, but the database
  // remembers the last run. Reporting "never" there would tell the user
  // nothing was collected while the dashboard is full of data.
  await withApi({
    storeSetup: async (s) => {
      await seedRepo(s);
      const id = await s.startPollRun('2026-09-04T09:00:00Z');
      await s.finishPollRun(id, { total: 88, ok: 87, failed: 1, at: '2026-09-04T09:04:00Z' });
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.equal(body.poll.lastRunAt, '2026-09-04T09:04:00Z');
    assert.equal(body.poll.lastResult.total, 88);
    assert.equal(body.poll.lastResult.ok, 87);
    assert.equal(body.poll.lastResult.failed, 1);
  });
});

test('GET /api/status prefers the live poller state over the persisted one', async () => {
  const live = { total: 5, ok: 5, failed: 0 };
  await withApi({
    poller: stubPoller({
      getState: () => ({
        running: false, total: 5, done: 5, failed: 0, currentRepo: null,
        lastRunAt: '2026-09-04T12:00:00Z', lastResult: live, seeding: false,
      }),
    }),
    storeSetup: async (s) => {
      await seedRepo(s);
      const id = await s.startPollRun('2026-09-04T09:00:00Z');
      await s.finishPollRun(id, { total: 88, ok: 87, failed: 1, at: '2026-09-04T09:04:00Z' });
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.equal(body.poll.lastRunAt, '2026-09-04T12:00:00Z', 'this run wins over the stale row');
    assert.deepEqual(body.poll.lastResult, live);
  });
});

test('GET /api/status reports dataPath as the sqlite file by default', async () => {
  await withApi({ config: { pollIntervalHours: 6, dbPath: '/tmp/x.db' } }, async (base) => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.equal(body.dataPath, '/tmp/x.db');
  });
});

// Regression: dataPath used to report config.dbPath unconditionally, which
// on a Postgres deployment is a SQLite file that doesn't exist. It must
// name the actual target instead — and never leak the connection string.
test('GET /api/status reports the Postgres target, not a meaningless sqlite path, when POSTGRES_URL is set', async () => {
  const postgresUrl = 'postgres://user:secret-password@example.neon.tech/db';
  await withApi({ config: { pollIntervalHours: 6, dbPath: '/tmp/x.db', postgresUrl } }, async (base) => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.equal(body.dataPath, 'neon postgres');
    assert.doesNotMatch(JSON.stringify(body), /secret-password/);
  });
});

test('GET /api/status without a token says so instead of failing', async () => {
  await withApi({ tokenInfo: { token: null, source: null, login: null } }, async (base) => {
    const res = await fetch(`${base}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.token, { present: false, source: null, login: null });
  });
});

test('GET /api/status surfaces a token validation error at the top level', async () => {
  await withApi({ tokenInfo: { token: 't', source: 'test', login: null, error: 'Bad credentials' } }, async (base) => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(body.token, { present: true, source: 'test', login: null });
    assert.equal(body.tokenError, 'Bad credentials');
  });
});

test('GET /api/repos returns summaries and honours the range', async () => {
  await withApi({ storeSetup: (s) => seedRepo(s) }, async (base) => {
    const all = await (await fetch(`${base}/api/repos`)).json();
    assert.equal(all.range, 'all');
    assert.equal(all.repos.length, 1);
    assert.equal(all.repos[0].fullName, 'octo/hello');
    assert.equal(all.repos[0].allTime.views, 107);
    assert.equal(all.repos[0].range.views, 107);

    const recent = await (await fetch(`${base}/api/repos?range=30`)).json();
    assert.equal(recent.range, '30');
    assert.equal(recent.repos[0].range.views, 7, 'January is outside the 30-day window');
    assert.equal(recent.repos[0].allTime.views, 107, 'all-time is unaffected by the range');
    assert.deepEqual(recent.repos[0].spark.days.length, 30, 'the spark window is densified to 30 days');
    assert.equal(recent.repos[0].spark.views.length, 30);
    assert.equal(recent.repos[0].spark.views.at(-4), 0, 'a day with no row is zero, not missing');
  });
});

test('GET /api/repos/:owner/:name returns a dense series and the snapshots', async () => {
  await withApi({ storeSetup: (s) => seedRepo(s) }, async (base) => {
    const body = await (await fetch(`${base}/api/repos/octo/hello?range=30`)).json();
    assert.equal(body.repo.fullName, 'octo/hello');
    assert.equal(body.coverage.firstDay, '2026-01-01');
    assert.equal(body.coverage.days, 2);
    assert.equal(body.totals.views, 7);
    assert.equal(body.allTime.views, 107);
    assert.deepEqual(body.latestWindow.views, { count: 7, uniques: 3 });

    assert.equal(body.series.days.length, 30, '2026-08-06 through 2026-09-04 inclusive');
    assert.equal(body.series.days[0], '2026-08-06');
    assert.equal(body.series.days.at(-1), '2026-09-04');
    assert.equal(body.series.views.length, 30);
    const i = body.series.days.indexOf('2026-09-03');
    assert.equal(body.series.views[i], 7);
    assert.equal(body.series.clones[i], 4);
    assert.equal(body.series.views[0], 0, 'days with no row are zero-filled');

    assert.equal(body.referrers.items[0].referrer, 'google.com');
    assert.equal(body.paths.items[0].path, '/octo/hello');
  });
});

test('the detail series for range=all starts at the first recorded day', async () => {
  await withApi({ storeSetup: (s) => seedRepo(s) }, async (base) => {
    const body = await (await fetch(`${base}/api/repos/octo/hello`)).json();
    assert.equal(body.series.days[0], '2026-01-01');
    assert.equal(body.series.days.at(-1), '2026-09-04');
    assert.equal(body.series.views[0], 100);
  });
});

test('repo detail includes a metrics series and says where watchers begin', async () => {
  await withApi({
    storeSetup: async (store) => {
      const repo = await seedRepo(store, 'octo/hello');
      // A backfilled day: no watcher figure exists for it.
      await store.recordRepoMetrics(repo.id, '2026-09-03', { stars: 10, forks: 2, watchers: null }, '2026-09-03T00:00:00Z');
      // A polled day: a real watcher figure.
      await store.recordRepoMetrics(repo.id, '2026-09-04', { stars: 12, forks: 3, watchers: 5 }, '2026-09-04T00:00:00Z');
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/repos/octo/hello?range=all`)).json();
    assert.deepEqual(body.metrics.days, ['2026-09-03', '2026-09-04']);
    assert.deepEqual(body.metrics.stars, [10, 12]);
    assert.deepEqual(body.metrics.forks, [2, 3]);
    assert.deepEqual(body.metrics.watchers, [null, 5]);
    // The first day a watcher figure exists — everything before it is history
    // GitHub does not publish, and the UI must say so rather than plot a zero.
    assert.equal(body.metrics.watchersFrom, '2026-09-04');
  });
});

test('watchersFrom is null when no watcher figure has ever been recorded', async () => {
  await withApi({
    storeSetup: async (store) => {
      const repo = await seedRepo(store, 'octo/hello');
      await store.recordRepoMetrics(repo.id, '2026-09-03', { stars: 1, forks: 0, watchers: null }, '2026-09-03T00:00:00Z');
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/repos/octo/hello?range=all`)).json();
    assert.equal(body.metrics.watchersFrom, null);
  });
});

test('cloneRatio is clones divided by unique cloners for the range', async () => {
  await withApi({
    storeSetup: async (store) => {
      const repo = await seedRepo(store, 'octo/hello');
      await store.ingestTrafficSeries(repo.id, 'clones', [
        { timestamp: '2026-09-03T00:00:00Z', count: 100, uniques: 2 },
      ], '2026-09-03T00:00:00Z');
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/repos/octo/hello?range=all`)).json();
    assert.equal(body.cloneRatio.clones, 100);
    assert.equal(body.cloneRatio.uniqueCloners, 2);
    assert.equal(body.cloneRatio.ratio, 50);
  });
});

test('cloneRatio is null rather than Infinity when nobody cloned', async () => {
  await withApi({
    // Not seedRepo: it always ingests a clones row, which would give a real
    // (non-null) ratio. This repo has no traffic rows at all.
    storeSetup: async (store) => {
      await store.upsertRepo({
        fullName: 'octo/hello', owner: 'octo', name: 'hello', private: false, description: null, htmlUrl: null,
      }, '2026-09-04T00:00:00Z');
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/repos/octo/hello?range=all`)).json();
    assert.equal(body.cloneRatio.ratio, null);
    // Not NaN, not Infinity — both would render as garbage in the UI.
    assert.equal(Number.isFinite(body.cloneRatio.ratio), false);
  });
});

test('the home list carries a cloneRatio per repo', async () => {
  await withApi({
    storeSetup: async (store) => {
      const repo = await seedRepo(store, 'octo/hello');
      await store.ingestTrafficSeries(repo.id, 'clones', [
        { timestamp: '2026-09-03T00:00:00Z', count: 9, uniques: 3 },
      ], '2026-09-03T00:00:00Z');
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/repos`)).json();
    assert.equal(body.repos[0].cloneRatio.ratio, 3);
  });
});

test('a repo with no data yet returns empty arrays, not an error', async () => {
  await withApi({
    storeSetup: (s) => s.upsertRepo({
      fullName: 'octo/empty', owner: 'octo', name: 'empty', private: false, description: null, htmlUrl: null,
    }, '2026-09-04T00:00:00Z'),
  }, async (base) => {
    const res = await fetch(`${base}/api/repos/octo/empty`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.series.days, []);
    assert.deepEqual(body.coverage, { firstDay: null, lastDay: null, days: 0 });
    assert.equal(body.latestWindow, null);
    assert.deepEqual(body.referrers, { day: null, items: [] });
  });
});

test('an untracked repo is a 404 from the detail endpoint, not a 200', async () => {
  await withApi({ storeSetup: (s) => seedRepo(s) }, async (base, store) => {
    assert.equal((await fetch(`${base}/api/repos/octo/hello`)).status, 200);
    await store.untrackRepo('octo/hello', '2026-09-04T13:00:00Z');
    const res = await fetch(`${base}/api/repos/octo/hello`);
    assert.equal(res.status, 404, 'untracking hides the repo from the detail endpoint');
    assert.equal((await res.json()).error.code, 'not_found');
    assert.equal(
      (await store.listRepos({ includeUntracked: true })).length, 1,
      'the row and its history still exist — this is a soft delete',
    );
  });
});

test('an unknown repo is a 404', async () => {
  await withApi({}, async (base) => {
    const res = await fetch(`${base}/api/repos/octo/missing`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
  });
});

test('POST /api/repos adds a repo, polls it immediately, and returns its summary', async () => {
  const polled = [];
  await withApi({
    poller: stubPoller({ pollRepo: async (repo) => { polled.push(repo.fullName); return { fullName: repo.fullName, ok: true, error: null }; } }),
    client: {
      getRepo: async (fullName) => ({
        full_name: fullName, name: fullName.split('/')[1], owner: { login: fullName.split('/')[0] },
        private: false, description: 'new', html_url: `https://github.com/${fullName}`,
        permissions: { push: true },
      }),
    },
  }, async (base, store) => {
    const res = await fetch(`${base}/api/repos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ full_name: 'octo/new' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.repo.fullName, 'octo/new');
    assert.deepEqual(polled, ['octo/new']);
    assert.equal(await store.countTrackedRepos(), 1);
  });
});

test('POST /api/repos rejects a malformed name before calling GitHub', async () => {
  await withApi({ client: { getRepo: async () => { throw new Error('should not be called'); } } }, async (base) => {
    const res = await fetch(`${base}/api/repos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ full_name: 'nope' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_repo');
  });
});

test('POST /api/repos surfaces a repo without traffic access as 403', async () => {
  await withApi({
    client: {
      getRepo: async (fullName) => ({
        full_name: fullName, name: 'x', owner: { login: 'octo' }, private: false,
        description: null, html_url: null, permissions: { push: false },
      }),
    },
  }, async (base) => {
    const res = await fetch(`${base}/api/repos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ full_name: 'octo/readonly' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'no_traffic_access');
  });
});

test('POST /api/repos without a token returns 503 with a fixable message', async () => {
  await withApi({ client: null, tokenInfo: { token: null, source: null, login: null } }, async (base) => {
    const res = await fetch(`${base}/api/repos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ full_name: 'octo/x' }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'no_token');
  });
});

test('DELETE untracks without deleting history and 404s for an unknown repo', async () => {
  await withApi({ storeSetup: (s) => seedRepo(s) }, async (base, store) => {
    const res = await fetch(`${base}/api/repos/octo/hello`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { untracked: true, fullName: 'octo/hello' });
    assert.equal(await store.countTrackedRepos(), 0);
    assert.equal((await store.listRepos({ includeUntracked: true })).length, 1);

    const again = await fetch(`${base}/api/repos/octo/hello`, { method: 'DELETE' });
    assert.equal(again.status, 404);
  });
});

test('GET /api/available-repos marks which repos are already tracked', async () => {
  await withApi({
    storeSetup: (s) => seedRepo(s),
    client: {
      listOwnedRepos: async () => [
        { fullName: 'octo/hello', owner: 'octo', name: 'hello', private: false, description: null, htmlUrl: 'u', pushedAt: '2026-09-01T00:00:00Z', canReadTraffic: true },
        { fullName: 'octo/other', owner: 'octo', name: 'other', private: true, description: null, htmlUrl: 'u', pushedAt: '2026-08-01T00:00:00Z', canReadTraffic: true },
      ],
    },
  }, async (base) => {
    const body = await (await fetch(`${base}/api/available-repos`)).json();
    assert.equal(body.repos.length, 2);
    assert.equal(body.repos.find((r) => r.fullName === 'octo/hello').tracked, true);
    assert.equal(body.repos.find((r) => r.fullName === 'octo/other').tracked, false);
  });
});

test('POST /api/seed discovers repositories and then polls them', async () => {
  const order = [];
  await withApi({
    poller: stubPoller({
      seedFromGitHub: async () => { order.push('seed'); return { added: 2, skipped: 0, total: 2 }; },
      pollAll: async () => { order.push('poll'); return { total: 2, ok: 2, failed: 0 }; },
    }),
    client: { listOwnedRepos: async () => [] },
  }, async (base) => {
    const res = await fetch(`${base}/api/seed`, { method: 'POST' });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { started: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ['seed', 'poll'], 'seeding runs first, then the poll');
  });
});

test('POST /api/seed without a token is a 503', async () => {
  await withApi({ client: null, tokenInfo: { token: null, source: null, login: null } }, async (base) => {
    const res = await fetch(`${base}/api/seed`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'no_token');
  });
});

test('POST /api/poll starts a run in the background and reports skips', async () => {
  let started = 0;
  await withApi({
    poller: stubPoller({ pollAll: async () => { started += 1; return { total: 1, ok: 1, failed: 0 }; } }),
  }, async (base) => {
    const res = await fetch(`${base}/api/poll`, { method: 'POST' });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { started: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(started, 1);
  });

  await withApi({
    poller: stubPoller({ pollAll: async () => ({ skipped: 'already_running' }) }),
  }, async (base) => {
    const res = await fetch(`${base}/api/poll`, { method: 'POST' });
    assert.equal(res.status, 202, 'a background run always answers 202');
  });
});

const cronConfig = { pollIntervalHours: 6, dbPath: '/tmp/x.db', cronSecret: 'test-secret' };

test('GET /api/poll rejects a request with no bearer token', async () => {
  await withApi({ client: {}, config: cronConfig }, async (base) => {
    const res = await fetch(`${base}/api/poll`);
    assert.equal(res.status, 401);
  });
});

test('GET /api/poll rejects a wrong bearer token', async () => {
  await withApi({ client: {}, config: cronConfig }, async (base) => {
    const res = await fetch(`${base}/api/poll`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(res.status, 401);
  });
});

test('GET /api/poll refuses when no secret is configured, rather than running open', async () => {
  await withApi({ client: {} }, async (base) => {
    const res = await fetch(`${base}/api/poll`, { headers: { authorization: 'Bearer test-secret' } });
    assert.equal(res.status, 401);
  });
});

test('GET /api/poll runs when the token matches', async () => {
  const poller = stubPoller({ pollDue: async () => ({ total: 2, ok: 2, failed: 0, remaining: 0 }) });
  await withApi({ client: {}, poller, config: cronConfig }, async (base) => {
    const res = await fetch(`${base}/api/poll`, { headers: { authorization: 'Bearer test-secret' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).total, 2);
  });
});

test('GET /api/poll passes the configured batch to the poller', async () => {
  let seenLimit = null;
  const poller = stubPoller({
    pollDue: async ({ limit }) => { seenLimit = limit; return { total: 0, ok: 0, failed: 0, remaining: 0 }; },
  });
  await withApi({ client: {}, poller, config: { ...cronConfig, pollBatch: 7 } }, async (base) => {
    await fetch(`${base}/api/poll`, { headers: { authorization: 'Bearer test-secret' } });
  });
  assert.equal(seenLimit, 7);
});

test('GET /api/poll reports 409 while another run holds the lock', async () => {
  await withApi({ client: {}, config: cronConfig }, async (base, store) => {
    await store.acquirePollLock('2026-09-04T12:00:00Z', '2099-01-01T00:00:00Z');
    const res = await fetch(`${base}/api/poll`, { headers: { authorization: 'Bearer test-secret' } });
    assert.equal(res.status, 409);
  });
});

test('GET /api/poll releases the lock even when the poll throws', async () => {
  const poller = stubPoller({ pollDue: async () => { throw new Error('boom'); } });
  await withApi({ client: {}, poller, config: cronConfig }, async (base, store) => {
    await fetch(`${base}/api/poll`, { headers: { authorization: 'Bearer test-secret' } }).catch(() => {});
    assert.equal(await store.getMeta('poll_lock'), null);
  });
});
