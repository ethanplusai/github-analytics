import { todayUtc } from './db.js';

export const silentLogger = { info() {}, warn() {}, error() {} };

export function isStale(repo, now, intervalHours) {
  if (!repo.lastPolledAt) return true;
  const age = now.getTime() - new Date(repo.lastPolledAt).getTime();
  return !(age < intervalHours * 3600 * 1000);
}

export class Poller {
  constructor({
    store, client, now = () => new Date(), concurrency = 5, intervalHours = 6, logger = silentLogger,
  }) {
    this.store = store;
    this.client = client;
    this.now = now;
    this.concurrency = concurrency;
    this.intervalHours = intervalHours;
    this.logger = logger;
    this.timer = null;
    this.state = {
      running: false,
      total: 0,
      done: 0,
      failed: 0,
      currentRepo: null,
      lastRunAt: null,
      lastResult: null,
      seeding: false,
    };
  }

  getState() {
    return { ...this.state };
  }

  async pollRepo(repo) {
    const now = this.now();
    const day = todayUtc(now);
    const iso = now.toISOString();
    try {
      const [clones, views, referrers, paths] = await Promise.all([
        this.client.getClones(repo.fullName),
        this.client.getViews(repo.fullName),
        this.client.getReferrers(repo.fullName),
        this.client.getPaths(repo.fullName),
      ]);

      this.store.ingestTrafficSeries(repo.id, 'clones', clones.points, iso);
      this.store.ingestTrafficSeries(repo.id, 'views', views.points, iso);
      this.store.ingestWindowSnapshot(repo.id, day, 'clones', { count: clones.count, uniques: clones.uniques });
      this.store.ingestWindowSnapshot(repo.id, day, 'views', { count: views.count, uniques: views.uniques });
      this.store.ingestReferrers(repo.id, day, referrers);
      this.store.ingestPaths(repo.id, day, paths);
      this.store.markPolled(repo.id, { at: iso });

      return { fullName: repo.fullName, ok: true, error: null };
    } catch (err) {
      this.store.markPolled(repo.id, { at: iso, error: err.message });
      this.logger.error(`poll failed for ${repo.fullName}: ${err.message}`);
      return { fullName: repo.fullName, ok: false, error: err.message, errorKind: err.kind };
    }
  }

  async pollAll() {
    if (!this.client) return { skipped: 'no_token' };
    if (this.state.running) return { skipped: 'already_running' };

    this.state.running = true;

    try {
      const repos = this.store.listRepos();
      const total = repos.length;
      this.state.total = total;
      this.state.done = 0;
      this.state.failed = 0;
      this.state.currentRepo = null;

      const startedAt = this.now().toISOString();
      const runId = this.store.startPollRun(startedAt);

      let ok = 0;
      let failed = 0;
      let aborted = null;
      let nextIndex = 0;

      const worker = async () => {
        for (;;) {
          if (aborted) return;
          const index = nextIndex;
          nextIndex += 1;
          if (index >= repos.length) return;
          const repo = repos[index];
          this.state.currentRepo = repo.fullName;
          const result = await this.pollRepo(repo);
          this.state.done += 1;
          if (result.ok) {
            ok += 1;
          } else {
            failed += 1;
            this.state.failed += 1;
            if (result.errorKind === 'rate_limit' && !aborted) {
              aborted = 'rate_limit';
            }
          }
        }
      };

      const workerCount = Math.max(1, Math.min(this.concurrency, total || 1));
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      const finishedAt = this.now().toISOString();
      this.store.finishPollRun(runId, { total, ok, failed, at: finishedAt });

      this.state.lastRunAt = finishedAt;
      const result = { total, ok, failed, startedAt, finishedAt, aborted };
      this.state.lastResult = result;
      return result;
    } finally {
      this.state.running = false;
      this.state.currentRepo = null;
    }
  }

  // `state.seeding` is owned here, not by callers — every caller (bootstrap,
  // and POST /api/seed directly) needs the flag raised for the duration of
  // the call, and previously only bootstrap() set it, so the /api/seed path
  // never surfaced "Finding repositories…" at all.
  async seedFromGitHub() {
    if (this.state.seeding) return { skipped: 'already_running' };
    this.state.seeding = true;
    try {
      const remote = await this.client.listOwnedRepos();
      const known = new Set(this.store.listRepos({ includeUntracked: true }).map((r) => r.fullName));
      const nowIso = this.now().toISOString();

      let added = 0;
      let skipped = 0;
      for (const repo of remote) {
        if (repo.canReadTraffic === true && !known.has(repo.fullName)) {
          this.store.upsertRepo({
            fullName: repo.fullName,
            owner: repo.owner,
            name: repo.name,
            private: repo.private,
            description: repo.description,
            htmlUrl: repo.htmlUrl,
          }, nowIso);
          added += 1;
        } else {
          skipped += 1;
        }
      }

      this.store.setMeta('seeded_at', nowIso);
      return { added, skipped, total: remote.length };
    } finally {
      this.state.seeding = false;
    }
  }

  async bootstrap({ autoSeed }) {
    if (!this.client) return { seeded: null, polled: null, error: 'no_token' };

    let seeded = null;
    if (autoSeed && !this.store.getMeta('seeded_at')) {
      try {
        seeded = await this.seedFromGitHub();
      } catch (err) {
        this.logger.error(`seeding failed: ${err.message}`);
        seeded = { error: err.message };
      }
    }

    let polled = null;
    try {
      const stale = this.store.listRepos().some((r) => isStale(r, this.now(), this.intervalHours));
      polled = stale ? await this.pollAll() : null;
    } catch (err) {
      this.logger.error(`polling failed: ${err.message}`);
      polled = { error: err.message };
    }

    return { seeded, polled, error: null };
  }

  start(intervalHours = this.intervalHours) {
    this.intervalHours = intervalHours;
    this.timer = setInterval(() => {
      this.pollAll().catch(() => {});
    }, intervalHours * 3600 * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
