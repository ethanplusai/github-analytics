import { timingSafeEqual } from 'node:crypto';
import { createRouter, sendJson, sendError, readJsonBody } from './http.js';
import { todayUtc, daysAgoUtc } from './db.js';
import { FULL_NAME_RE, normaliseRepo, GitHubError } from './github.js';

const MAX_SERIES_DAYS = 3650;
const AVAILABLE_REPOS_TTL_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;
const POLL_BATCH = 40;
const POLL_DEADLINE_MS = 45_000;

// Constant-time compare that does not leak length through an early return.
function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const RANGE_DAYS = { 30: 30, 90: 90, 365: 365 };

/**
 * Map a `range` query param to `{ range, sinceDay }`. Presets are inclusive
 * of today: `range=30` starts 29 days back so the window is exactly 30 days
 * wide. Anything unrecognised (including `all` or missing) falls back to
 * the full history rather than erroring.
 */
export function resolveRange(rangeParam, now) {
  const days = Object.hasOwn(RANGE_DAYS, rangeParam) ? RANGE_DAYS[rangeParam] : undefined;
  if (days) {
    return { range: String(rangeParam), sinceDay: daysAgoUtc(now, days - 1) };
  }
  return { range: 'all', sinceDay: null };
}

// The day after `day` (an ISO 'YYYY-MM-DD' string), computed via the UTC
// midnight Date so month/year boundaries roll over correctly.
function nextDay(day) {
  return daysAgoUtc(new Date(`${day}T00:00:00Z`), -1);
}

// Every ISO day string from `start` to `end` inclusive, capped so a bad
// input can't spin the server into an unbounded loop.
function dayRange(start, end) {
  const days = [];
  let cursor = start;
  while (cursor <= end && days.length < MAX_SERIES_DAYS) {
    days.push(cursor);
    cursor = nextDay(cursor);
  }
  return days;
}

// Walk `sinceDay` (or the repo's first day, whichever is later) through
// today, zero-filling any day with no stored row so every chart shares an
// evenly spaced x-axis. Returns empty arrays for a repo with no data at all.
async function denseSeries(store, repoId, sinceDay, now) {
  const coverage = await store.coverage(repoId);
  if (!coverage.firstDay) {
    return { days: [], clones: [], uniqueCloners: [], views: [], uniqueVisitors: [] };
  }

  const start = sinceDay
    ? (sinceDay > coverage.firstDay ? sinceDay : coverage.firstDay)
    : coverage.firstDay;
  const days = dayRange(start, todayUtc(now));

  const viewsMap = new Map((await store.dailySeries(repoId, 'views', start)).map((r) => [r.day, r]));
  const clonesMap = new Map((await store.dailySeries(repoId, 'clones', start)).map((r) => [r.day, r]));

  return {
    days,
    views: days.map((d) => viewsMap.get(d)?.count ?? 0),
    uniqueVisitors: days.map((d) => viewsMap.get(d)?.uniques ?? 0),
    clones: days.map((d) => clonesMap.get(d)?.count ?? 0),
    uniqueCloners: days.map((d) => clonesMap.get(d)?.uniques ?? 0),
  };
}

// Expand a sparse { days, views, clones } spark (only days with rows) into a
// fixed, zero-filled window so every card's sparkline shares one x-axis.
function densifySpark(spark, sinceDay, now) {
  const viewsByDay = new Map(spark.days.map((d, i) => [d, spark.views[i]]));
  const clonesByDay = new Map(spark.days.map((d, i) => [d, spark.clones[i]]));
  const days = dayRange(sinceDay, todayUtc(now));

  return {
    days,
    views: days.map((d) => viewsByDay.get(d) ?? 0),
    clones: days.map((d) => clonesByDay.get(d) ?? 0),
  };
}

function densifySummary(summary, sparkSinceDay, now) {
  return { ...summary, spark: densifySpark(summary.spark, sparkSinceDay, now) };
}

function mapGitHubError(err) {
  switch (err.kind) {
    case 'auth': return { status: 401, code: 'bad_token' };
    case 'rate_limit': return { status: 429, code: 'rate_limited' };
    case 'forbidden': return { status: 403, code: 'forbidden' };
    case 'not_found': return { status: 404, code: 'not_found' };
    default: return { status: 502, code: 'github_error' };
  }
}

function sendGitHubError(res, err) {
  const { status, code } = mapGitHubError(err);
  sendError(res, status, code, err.message);
}

export function createApi({ store, poller, client, tokenInfo, config, version, now = () => new Date() }) {
  const router = createRouter();
  let availableReposCache = null; // { at, repos } — closed over per API instance, never module-scoped

  router.get('/api/health', async (req, res) => {
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/status', async (req, res) => {
    const poll = poller.getState();
    // A freshly started process has no in-memory run yet, but the database
    // remembers the last one. Without this fallback the dashboard would
    // report "Updated never" after every restart, while sitting on months of
    // collected traffic.
    if (!poll.lastRunAt) {
      const persisted = await store.lastPollRun();
      if (persisted) {
        poll.lastRunAt = persisted.finishedAt ?? persisted.startedAt;
        poll.lastResult = {
          total: persisted.total,
          ok: persisted.ok,
          failed: persisted.failed,
        };
      }
    }
    sendJson(res, 200, {
      version,
      token: {
        present: Boolean(tokenInfo?.token),
        source: tokenInfo?.source ?? null,
        login: tokenInfo?.login ?? null,
      },
      tokenError: tokenInfo?.error ?? null,
      repoCount: await store.countTrackedRepos(),
      poll,
      pollIntervalHours: config.pollIntervalHours,
      seededAt: await store.getMeta('seeded_at'),
      dataPath: config.dbPath,
    });
  });

  router.get('/api/repos', async (req, res, ctx) => {
    const { range, sinceDay } = resolveRange(ctx.query.range, now());
    const sparkSinceDay = daysAgoUtc(now(), 29);
    const summaries = await store.repoSummaries({ sinceDay, sparkSinceDay });
    sendJson(res, 200, {
      range,
      sinceDay,
      generatedAt: now().toISOString(),
      repos: summaries.map((s) => densifySummary(s, sparkSinceDay, now())),
    });
  });

  router.post('/api/repos', async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const code = err.code === 'TOO_LARGE' ? 'too_large' : 'bad_json';
      sendError(res, 400, code, err.message);
      return;
    }

    const fullName = body?.full_name;
    if (typeof fullName !== 'string' || !FULL_NAME_RE.test(fullName)) {
      sendError(res, 400, 'invalid_repo', 'full_name must look like owner/repo');
      return;
    }

    if (!client) {
      sendError(res, 503, 'no_token', 'No GitHub token is configured; add one to track repos');
      return;
    }

    let apiRepo;
    try {
      apiRepo = await client.getRepo(fullName);
    } catch (err) {
      if (err instanceof GitHubError) {
        sendGitHubError(res, err);
        return;
      }
      throw err;
    }

    const normalised = normaliseRepo(apiRepo);
    if (!normalised.canReadTraffic) {
      sendError(res, 403, 'no_traffic_access', `No push access to ${fullName}; traffic stats require it`);
      return;
    }

    const repo = await store.upsertRepo(normalised, now().toISOString());
    const poll = await poller.pollRepo(repo);

    const sparkSinceDay = daysAgoUtc(now(), 29);
    const summary = (await store.repoSummaries({ sinceDay: null, sparkSinceDay }))
      .find((r) => r.fullName === fullName);

    sendJson(res, 201, {
      repo: densifySummary(summary, sparkSinceDay, now()),
      poll,
    });
  });

  router.delete('/api/repos/:owner/:name', async (req, res, ctx) => {
    const fullName = `${ctx.params.owner}/${ctx.params.name}`;
    const untracked = await store.untrackRepo(fullName, now().toISOString());
    if (!untracked) {
      sendError(res, 404, 'not_found', `${fullName} is not tracked`);
      return;
    }
    sendJson(res, 200, { untracked: true, fullName });
  });

  router.get('/api/repos/:owner/:name', async (req, res, ctx) => {
    const fullName = `${ctx.params.owner}/${ctx.params.name}`;
    const repo = await store.getRepo(fullName);
    // An untracked repo keeps its row and its history (untracking is a soft
    // delete), but it is no longer part of the dashboard — so it reads as
    // absent here, exactly as one that was never added.
    if (!repo || !repo.tracked) {
      sendError(res, 404, 'not_found', `${fullName} is not tracked`);
      return;
    }

    const { range, sinceDay } = resolveRange(ctx.query.range, now());
    const coverage = await store.coverage(repo.id);
    const totals = await store.totals(repo.id, sinceDay);
    const allTime = await store.totals(repo.id, null);
    const latestWindow = await store.latestWindow(repo.id);
    const series = await denseSeries(store, repo.id, sinceDay, now());
    const referrers = await store.latestReferrers(repo.id, 20);
    const paths = await store.latestPaths(repo.id, 20);

    sendJson(res, 200, {
      repo: {
        id: repo.id,
        fullName: repo.fullName,
        owner: repo.owner,
        name: repo.name,
        private: repo.private,
        description: repo.description,
        htmlUrl: repo.htmlUrl,
        addedAt: repo.addedAt,
        lastPolledAt: repo.lastPolledAt,
        lastError: repo.lastError,
      },
      range,
      sinceDay,
      coverage,
      totals,
      allTime,
      latestWindow,
      series,
      referrers,
      paths,
    });
  });

  router.get('/api/available-repos', async (req, res) => {
    if (!client) {
      sendError(res, 503, 'no_token', 'No GitHub token is configured; add one to browse repos');
      return;
    }

    let remote;
    const cacheAge = availableReposCache ? now().getTime() - availableReposCache.at : Infinity;
    if (availableReposCache && cacheAge < AVAILABLE_REPOS_TTL_MS) {
      remote = availableReposCache.repos;
    } else {
      try {
        remote = await client.listOwnedRepos();
      } catch (err) {
        if (err instanceof GitHubError) {
          sendGitHubError(res, err);
          return;
        }
        throw err;
      }
      availableReposCache = { at: now().getTime(), repos: remote };
    }

    const tracked = new Set((await store.listRepos()).map((r) => r.fullName));
    sendJson(res, 200, {
      repos: remote.map((r) => ({ ...r, tracked: tracked.has(r.fullName) })),
    });
  });

  router.post('/api/poll', async (req, res) => {
    poller.pollAll().catch(() => {});
    sendJson(res, 202, { started: true });
  });

  router.get('/api/poll', async (req, res) => {
    // Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when
    // CRON_SECRET is set on the project. With no secret configured the
    // endpoint stays closed rather than open — this route can spend the
    // GitHub token, so failing open would be the wrong default.
    const expected = config.cronSecret;
    const provided = req.headers.authorization ?? '';
    if (!expected || !timingSafeEqualString(provided, `Bearer ${expected}`)) {
      sendError(res, 401, 'unauthorized', 'This endpoint requires the cron secret.');
      return;
    }
    if (!client) {
      sendError(res, 503, 'no_token', 'No GitHub token is configured.');
      return;
    }

    const startedAt = now();
    const expiresAt = new Date(startedAt.getTime() + LOCK_TTL_MS).toISOString();
    if (!await store.acquirePollLock(startedAt.toISOString(), expiresAt)) {
      sendError(res, 409, 'already_running', 'Another poll run holds the lock.');
      return;
    }

    try {
      let seeded = null;
      if (!await store.getMeta('seeded_at')) seeded = await poller.seedFromGitHub();
      const result = await poller.pollDue({ limit: POLL_BATCH, deadlineMs: POLL_DEADLINE_MS });
      sendJson(res, 200, { ...result, seeded });
    } finally {
      await store.releasePollLock(expiresAt);
    }
  });

  router.post('/api/seed', async (req, res) => {
    if (!client) {
      sendError(res, 503, 'no_token', 'No GitHub token is configured; add one to find repos');
      return;
    }
    poller.seedFromGitHub().then(() => poller.pollAll()).catch(() => {});
    sendJson(res, 202, { started: true });
  });

  return router;
}
