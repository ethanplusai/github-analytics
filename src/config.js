import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

const DEFAULT_PORT = 4319;
const DEFAULT_POLL_INTERVAL_HOURS = 6;

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
    allowedHosts: (env.GHA_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
