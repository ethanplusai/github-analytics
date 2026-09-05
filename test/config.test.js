import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig uses sensible defaults with an empty environment', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 4319);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.pollIntervalHours, 6);
  assert.equal(cfg.autoSeed, true);
  assert.equal(cfg.autoOpen, true);
  assert.equal(cfg.envToken, null);
  assert.match(cfg.dataDir, /\.github-analytics$/);
  assert.match(cfg.dbPath, /analytics\.db$/);
  assert.equal(cfg.apiBaseUrl, 'https://api.github.com');
});

test('loadConfig honours environment overrides', () => {
  const cfg = loadConfig({
    GHA_DATA_DIR: '/tmp/gha',
    PORT: '8080',
    GHA_HOST: '0.0.0.0',
    GHA_POLL_INTERVAL_HOURS: '12',
    GHA_AUTO_SEED: '0',
    GHA_OPEN: '0',
    GITHUB_TOKEN: 'ghp_env',
  });
  assert.equal(cfg.dataDir, '/tmp/gha');
  assert.equal(cfg.dbPath, '/tmp/gha/analytics.db');
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.pollIntervalHours, 12);
  assert.equal(cfg.autoSeed, false);
  assert.equal(cfg.autoOpen, false);
  assert.equal(cfg.envToken, 'ghp_env');
});

test('loadConfig ignores a non-numeric port and falls back to the default', () => {
  assert.equal(loadConfig({ PORT: 'not-a-number' }).port, 4319);
  assert.equal(loadConfig({ GHA_POLL_INTERVAL_HOURS: 'x' }).pollIntervalHours, 6);
});

test('cloud mode is selected by POSTGRES_URL and VERCEL', () => {
  const cfg = loadConfig({ POSTGRES_URL: 'postgres://x', VERCEL: '1', CRON_SECRET: 's',
    GHA_ALLOWED_HOSTS: 'github.ethanplus.ai, gha.vercel.app' });
  assert.equal(cfg.postgresUrl, 'postgres://x');
  assert.equal(cfg.serverless, true);
  assert.equal(cfg.pollMode, 'cron');
  assert.equal(cfg.cronSecret, 's');
  assert.deepEqual(cfg.allowedHosts, ['github.ethanplus.ai', 'gha.vercel.app']);
});

test('local mode is the default and keeps the interval poller', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.postgresUrl, null);
  assert.equal(cfg.serverless, false);
  assert.equal(cfg.pollMode, 'interval');
  assert.deepEqual(cfg.allowedHosts, []);
});
