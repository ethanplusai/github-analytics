#!/usr/bin/env node
import { dayOf, todayUtc, daysAgoUtc } from '../src/db.js';
import { Store } from '../src/store.js';
import { GitHubClient } from '../src/github.js';
import { loadConfig } from '../src/config.js';
import { discoverToken } from '../src/token.js';

// Turns a list of event timestamps (when each star or fork was created) into a
// cumulative count per day, filling the gaps — GitHub gives us the events, the
// dashboard wants a curve.
export function dailyCountsFromTimestamps(timestamps, { upTo }) {
  const days = timestamps.map(dayOf).filter((d) => d <= upTo).sort();
  if (days.length === 0) return [];

  const perDay = new Map();
  for (const day of days) perDay.set(day, (perDay.get(day) ?? 0) + 1);

  const series = [];
  let running = 0;
  let cursor = days[0];
  while (cursor <= upTo) {
    running += perDay.get(cursor) ?? 0;
    series.push({ day: cursor, count: running });
    cursor = daysAgoUtc(new Date(`${cursor}T00:00:00Z`), -1);
  }
  return series;
}

// Existing rows are never overwritten. The poller owns real readings — today's
// especially — and a backfill re-run must not be able to replace one with a
// reconstruction.
export async function backfillRepo({
  store, client, repo, upTo = todayUtc(), log = () => {},
}) {
  const [starDates, forkDates] = await Promise.all([
    client.listStargazerDates(repo.fullName),
    client.listForkDates(repo.fullName),
  ]);

  const stars = new Map(dailyCountsFromTimestamps(starDates, { upTo }).map((r) => [r.day, r.count]));
  const forks = new Map(dailyCountsFromTimestamps(forkDates, { upTo }).map((r) => [r.day, r.count]));
  const days = [...new Set([...stars.keys(), ...forks.keys()])].sort();
  if (days.length === 0) return { days: 0, skipped: 0 };

  const existing = new Set((await store.metricsSeries(repo.id, days[0])).map((r) => r.day));
  const nowIso = new Date().toISOString();

  let written = 0;
  let skipped = 0;
  let lastStars = 0;
  let lastForks = 0;
  for (const day of days) {
    lastStars = stars.get(day) ?? lastStars;
    lastForks = forks.get(day) ?? lastForks;
    if (existing.has(day)) { skipped += 1; continue; }
    // watchers is null for every backfilled row: GitHub publishes no timestamp
    // for subscribers, so any number here would be invented.
    await store.recordRepoMetrics(repo.id, day, { stars: lastStars, forks: lastForks, watchers: null }, nowIso);
    written += 1;
  }
  log(`  ${repo.fullName} — ${written} days written, ${skipped} left alone`);
  return { days: written, skipped };
}

// --- CLI --------------------------------------------------------------
//
// Invoked directly: reconstruct star/fork history for every tracked repo from
// GitHub's still-available stargazer/fork timestamps, into the real store.
// Does NOT touch traffic_daily, and never overwrites a day the poller has
// already recorded (see backfillRepo above).
async function main() {
  const config = loadConfig();

  const { token, source } = await discoverToken();
  if (!token) {
    console.error('No GitHub token found (checked GITHUB_TOKEN, GH_TOKEN, and `gh auth token`).');
    process.exit(1);
    return;
  }
  console.log(`Token:  ${source}`);

  let driver;
  if (config.postgresUrl) {
    console.log('Target: Postgres (POSTGRES_URL)');
    const { createPostgresDriver } = await import('../src/db/postgres.js');
    driver = await createPostgresDriver(config.postgresUrl);
  } else {
    console.log(`Target: ${config.dbPath}`);
    const { createSqliteDriver } = await import('../src/db/sqlite.js');
    driver = createSqliteDriver(config.dbPath);
  }

  const store = new Store(driver);
  const client = new GitHubClient({ token, baseUrl: config.apiBaseUrl });

  let failures = 0;
  let totalDays = 0;
  try {
    const repos = await store.listRepos();
    for (const repo of repos) {
      try {
        const result = await backfillRepo({ store, client, repo, log: console.log });
        totalDays += result.days;
      } catch (err) {
        failures += 1;
        console.error(`  ${repo.fullName} — FAILED: ${err.message}`);
      }
    }
  } finally {
    await store.close();
  }

  console.log(`\n${totalDays} day(s) written across ${failures === 0 ? 'all' : 'the surviving'} repos.`);
  if (failures > 0) {
    console.error(`${failures} repo(s) failed.`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nBackfill failed: ${err.message}`);
    process.exit(1);
  });
}
