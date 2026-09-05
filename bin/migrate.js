#!/usr/bin/env node
import { Store } from '../src/store.js';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { loadConfig } from '../src/config.js';

// Reads through the source Store and writes through the target Store, so both
// sides go through the same validated SQL rather than raw dumped rows. Safe to
// run twice: repos upsert on full_name, traffic upserts monotonically, and
// snapshots are replaced per (repo, day).
export async function migrate({ from, to, log = console.log }) {
  const repos = await from.listRepos({ includeUntracked: true });
  let trafficRows = 0;
  const mismatches = [];

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

    const [sourceTotals, targetTotals] = [await from.totals(repo.id, null), await to.totals(target.id, null)];
    const [sourceCoverage, targetCoverage] = [await from.coverage(repo.id), await to.coverage(target.id)];
    if (JSON.stringify(sourceTotals) !== JSON.stringify(targetTotals)
      || JSON.stringify(sourceCoverage) !== JSON.stringify(targetCoverage)) {
      mismatches.push({ repo: repo.fullName, sourceTotals, targetTotals, sourceCoverage, targetCoverage });
      log(`  MISMATCH ${repo.fullName}`);
    } else {
      log(`  ok ${repo.fullName} — ${sourceCoverage.days} days`);
    }
  }

  const seededAt = await from.getMeta('seeded_at');
  if (seededAt) await to.setMeta('seeded_at', seededAt);

  return { repos: repos.length, trafficRows, mismatches };
}

// --- CLI ------------------------------------------------------------------
//
// Invoked directly: copy the real local history into the real Neon database.
// The source is opened read/write by the driver (SQLite has no read-only
// connection mode here), but `migrate()` never calls anything on `from`
// except reads — see the loop above, which only ever writes through `to`.
async function main() {
  const config = loadConfig();

  // config.dbPath always has a value — it falls back to
  // ~/.github-analytics/analytics.db — so only the migration target can be
  // genuinely missing.
  if (!config.postgresUrl) {
    console.error('POSTGRES_URL (or DATABASE_URL) is not set. Refusing to run without a migration target.');
    process.exit(1);
  }

  console.log(`Source:      ${config.dbPath}`);
  console.log('Target:      Postgres (POSTGRES_URL)');

  const source = new Store(createSqliteDriver(config.dbPath));
  const { createPostgresDriver } = await import('../src/db/postgres.js');
  const target = new Store(await createPostgresDriver(config.postgresUrl));

  try {
    const result = await migrate({ from: source, to: target, log: console.log });
    console.log(`\n${result.repos} repos, ${result.trafficRows} traffic rows copied.`);
    if (result.mismatches.length > 0) {
      console.error(`${result.mismatches.length} repo(s) failed verification:`);
      for (const m of result.mismatches) console.error(JSON.stringify(m, null, 2));
      process.exitCode = 1;
    } else {
      console.log('All repos verified: totals and coverage match on both sides.');
    }
  } finally {
    await source.close();
    await target.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
