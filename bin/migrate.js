#!/usr/bin/env node
import { Store } from '../src/store.js';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { loadConfig } from '../src/config.js';

// `latestReferrers`/`latestPaths` order their rows `count DESC, <text> ASC`
// in SQL, but SQLite (BINARY collation) and Postgres (locale collation, e.g.
// `en_US.UTF-8`) do not agree on text order for entries tied on count — so
// two rows that copied perfectly can still come back in a different order
// on each side. Sorting by a stable key here, in JS, before comparing makes
// the check independent of either engine's collation; the SQL and the UI's
// ordering are untouched.
function sortedBy(items, key) {
  return [...items].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

function normaliseList(result, key) {
  return { ...result, items: sortedBy(result.items, key) };
}

// Verification is by comparison, not trust: every field listed here is read
// back from both sides and compared. A repo with zero window/referrer/path
// snapshots still gets a real check — `latestWindow`/`latestReferrers`/
// `latestPaths` returning the same "nothing yet" shape on both sides is
// itself a pass, not something to skip.
async function compareRepo(from, to, sourceRepoId, targetRepoId) {
  const checks = [
    ['totals', () => from.totals(sourceRepoId, null), () => to.totals(targetRepoId, null)],
    ['coverage', () => from.coverage(sourceRepoId), () => to.coverage(targetRepoId)],
    ['window', () => from.latestWindow(sourceRepoId), () => to.latestWindow(targetRepoId)],
    ['referrers',
      async () => normaliseList(await from.latestReferrers(sourceRepoId, 50), 'referrer'),
      async () => normaliseList(await to.latestReferrers(targetRepoId, 50), 'referrer')],
    ['paths',
      async () => normaliseList(await from.latestPaths(sourceRepoId, 50), 'path'),
      async () => normaliseList(await to.latestPaths(targetRepoId, 50), 'path')],
    ['snapshotDayCount',
      async () => (await from.snapshotDays(sourceRepoId)).length,
      async () => (await to.snapshotDays(targetRepoId)).length],
  ];

  const mismatches = [];
  let coverage = null;
  for (const [field, readSource, readTarget] of checks) {
    const [source, target] = [await readSource(), await readTarget()];
    if (field === 'coverage') coverage = source;
    if (JSON.stringify(source) !== JSON.stringify(target)) {
      mismatches.push({ field, source, target });
    }
  }
  return { mismatches, coverage };
}

// Compares every already-copied repo between the two stores, independent of
// the copy step itself. Exported on its own — not just inlined into
// `migrate` — so it can be re-run against an existing copy without touching
// it: the thing that proves a copy arrived intact must be able to run
// without also being the thing that could paper over a gap by re-copying it.
export async function verify({ from, to, log = console.log }) {
  const repos = await from.listRepos({ includeUntracked: true });
  const mismatches = [];

  for (const repo of repos) {
    const target = await to.getRepo(repo.fullName);
    if (!target) {
      mismatches.push({ repo: repo.fullName, field: 'presence', source: 'present', target: 'missing' });
      log(`  MISMATCH ${repo.fullName} (missing from target)`);
      continue;
    }

    const { mismatches: repoMismatches, coverage } = await compareRepo(from, to, repo.id, target.id);
    if (repoMismatches.length > 0) {
      for (const m of repoMismatches) mismatches.push({ repo: repo.fullName, ...m });
      log(`  MISMATCH ${repo.fullName} (${repoMismatches.map((m) => m.field).join(', ')})`);
    } else {
      log(`  ok ${repo.fullName} — traffic, window, referrers and paths verified — ${coverage.days} days`);
    }
  }

  return { mismatches };
}

// Reads through the source Store and writes through the target Store, so both
// sides go through the same validated SQL rather than raw dumped rows. Safe to
// run twice: repos upsert on full_name, traffic upserts monotonically, and
// snapshots are replaced per (repo, day).
export async function migrate({ from, to, log = console.log }) {
  const repos = await from.listRepos({ includeUntracked: true });
  let trafficRows = 0;

  for (const repo of repos) {
    const target = await to.upsertRepo({
      fullName: repo.fullName, owner: repo.owner, name: repo.name,
      private: repo.private, description: repo.description, htmlUrl: repo.htmlUrl,
    }, repo.addedAt);

    for (const kind of ['clones', 'views']) {
      const rows = await from.dailySeries(repo.id, kind, null);
      if (rows.length > 0) {
        await to.ingestTrafficSeries(
          target.id, kind,
          rows.map((r) => ({ timestamp: `${r.day}T00:00:00Z`, count: r.count, uniques: r.uniques })),
          repo.lastPolledAt ?? repo.addedAt,
        );
        trafficRows += rows.length;
      }
    }

    for (const day of await from.snapshotDays(repo.id)) {
      for (const kind of ['clones', 'views']) {
        const snap = await from.windowSnapshot(repo.id, day, kind);
        if (snap) await to.ingestWindowSnapshot(target.id, day, kind, snap);
      }
      await to.ingestReferrers(target.id, day, await from.referrersOn(repo.id, day));
      await to.ingestPaths(target.id, day, await from.pathsOn(repo.id, day));
    }

    if (!repo.tracked) await to.untrackRepo(repo.fullName, repo.untrackedAt ?? repo.addedAt);
    if (repo.lastPolledAt) await to.markPolled(target.id, { at: repo.lastPolledAt, error: repo.lastError });
  }

  const seededAt = await from.getMeta('seeded_at');
  if (seededAt) await to.setMeta('seeded_at', seededAt);

  const { mismatches } = await verify({ from, to, log });
  return { repos: repos.length, trafficRows, mismatches };
}

// --- CLI ------------------------------------------------------------------
//
// Invoked directly: copy the real local history into the real Neon database.
// The source is opened with SQLite's own read-only connection mode — no WAL
// switch, no schema creation, no user_version bump — so it is provably, not
// just intentionally, never written to. `migrate()` only ever writes through
// `to` regardless, but this is the source's only copy of data GitHub has
// already deleted, so the open itself must not touch it either.
async function main() {
  const config = loadConfig();

  // config.dbPath always has a value — it falls back to
  // ~/.github-analytics/analytics.db — so only the migration target can be
  // genuinely missing.
  if (!config.postgresUrl) {
    console.error('POSTGRES_URL (or DATABASE_URL) is not set. Refusing to run without a migration target.');
    process.exit(1);
  }

  console.log(`Source:      ${config.dbPath} (read-only)`);
  console.log('Target:      Postgres (POSTGRES_URL)');

  let source;
  try {
    source = new Store(createSqliteDriver(config.dbPath, { readOnly: true }));
  } catch (err) {
    console.error(
      `Could not open ${config.dbPath} read-only: ${err.message}. ` +
      `Make a backup copy first (sqlite3 ${config.dbPath} ".backup /tmp/gha-migrate.db") ` +
      'and re-run with GHA_DB_PATH=/tmp/gha-migrate.db',
    );
    process.exit(1);
    return;
  }

  const { createPostgresDriver } = await import('../src/db/postgres.js');
  const target = new Store(await createPostgresDriver(config.postgresUrl));

  try {
    const result = await migrate({ from: source, to: target, log: console.log });
    console.log(`\n${result.repos} repos, ${result.trafficRows} traffic rows copied.`);
    if (result.mismatches.length > 0) {
      console.error(`${result.mismatches.length} field mismatch(es) across the copy:`);
      for (const m of result.mismatches) console.error(JSON.stringify(m, null, 2));
      process.exitCode = 1;
    } else {
      console.log('All repos verified: totals, coverage, window, referrers and paths match on both sides.');
    }
  } finally {
    await source.close();
    await target.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nMigration failed: ${err.message}`);
    console.error(
      'Re-running the migration is safe: repos upsert on full_name, traffic upserts monotonically, ' +
      'and snapshots are replaced per (repo, day) — nothing already copied will be duplicated or lowered.',
    );
    process.exit(1);
  });
}
