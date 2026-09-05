import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

const DEFAULT_PORT = 4319;
const DEFAULT_POLL_INTERVAL_HOURS = 6;
const DEFAULT_POLL_DEADLINE_MS = 45_000;
const DEFAULT_POLL_BATCH = 250;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

export function loadConfig(env = process.env) {
  const rawDataDir = env.GHA_DATA_DIR || join(homedir(), '.github-analytics');
  const dataDir = isAbsolute(rawDataDir) ? rawDataDir : resolve(rawDataDir);
  const allowedHosts = (env.GHA_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Whether this instance can be reached by anything other than the machine
  // it runs on. `VERCEL` names one public shape (Vercel's own). A non-empty
  // `GHA_ALLOWED_HOSTS` names the other one this app documents — self-hosted
  // behind a reverse proxy on a real hostname (see docs/DEPLOYMENT.md) — and
  // is already required for that shape to work at all, so treating it as the
  // exposure signal costs an operator nothing extra to set. This single flag
  // drives both `secureCookies` below and the passphrase-strength gate in
  // `assertSafeToStart` (server.js): both need "is this exposed", and
  // computing it twice would let the two drift apart, the way the
  // passphrase-length check once did against a padded env value.
  const exposedBeyondLoopback = Boolean(env.VERCEL) || allowedHosts.length > 0;
  return {
    dataDir,
    dbPath: env.GHA_DB_PATH || join(dataDir, 'analytics.db'),
    host: env.GHA_HOST || '127.0.0.1',
    port: num(env.PORT || env.GHA_PORT, DEFAULT_PORT),
    pollIntervalHours: num(env.GHA_POLL_INTERVAL_HOURS, DEFAULT_POLL_INTERVAL_HOURS),
    autoSeed: bool(env.GHA_AUTO_SEED, true),
    autoOpen: bool(env.GHA_OPEN, true),
    envToken: env.GITHUB_TOKEN || env.GH_TOKEN || null,
    apiBaseUrl: env.GHA_API_BASE_URL || 'https://api.github.com',
    postgresUrl: env.POSTGRES_URL || env.DATABASE_URL || null,
    serverless: Boolean(env.VERCEL),
    // Cron mode when there is no long-lived process to hold a timer. An
    // explicit GHA_POLL_MODE always wins, so the cloud shape can be exercised
    // locally.
    pollMode: env.GHA_POLL_MODE || (env.VERCEL ? 'cron' : 'interval'),
    cronSecret: env.CRON_SECRET || null,
    // How long GET /api/poll may run before it stops starting new repos and
    // returns. Must stay below the platform's function `maxDuration` (see
    // `vercel.json`) — otherwise the platform kills the invocation first,
    // the lock's `finally` never runs, and the poll lock sits for its full
    // TTL instead of being released promptly.
    pollDeadlineMs: num(env.GHA_POLL_DEADLINE_MS, DEFAULT_POLL_DEADLINE_MS),
    // A ceiling, not a promise: GHA_POLL_DEADLINE_MS is what actually bounds a
    // run. 250 covers the current fleet of 88 with room to grow, and a poll of
    // 40 repos measured 14s (~0.35s each), so 88 lands near 31s — inside both
    // the 45s deadline and Vercel's 60s function cap.
    pollBatch: num(env.GHA_POLL_BATCH, DEFAULT_POLL_BATCH),
    allowedHosts,
    password: env.GHA_PASSWORD || null,
    allowPublic: bool(env.GHA_ALLOW_PUBLIC, false),
    // Whether this instance is actually exposed beyond loopback — see the
    // comment above. Kept on the config object (rather than recomputed from
    // `serverless`/`allowedHosts` wherever it's needed) so there is exactly
    // one place that decides "is this deployment exposed".
    exposedBeyondLoopback,
    // Cookie `Secure`/`__Host-` and the passphrase floor should be decided by
    // how the app is actually reachable, not by which hosting provider it's
    // on — `serverless` alone missed the self-hosted-behind-a-proxy shape
    // entirely (see docs/DEPLOYMENT.md's nginx/systemd sections), which let a
    // real public deployment get a cleartext, non-`Secure` session cookie and
    // skip the passphrase floor. `GHA_SECURE_COOKIES` lets an operator with
    // an unusual topology (e.g. TLS terminated somewhere this process can't
    // see) override either direction explicitly.
    secureCookies: bool(env.GHA_SECURE_COOKIES, exposedBeyondLoopback),
  };
}
