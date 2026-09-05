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

test('the poll batch defaults high enough to cover the whole fleet', () => {
  assert.equal(loadConfig({}).pollBatch, 250);
  assert.equal(loadConfig({ GHA_POLL_BATCH: '10' }).pollBatch, 10);
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

test('pollDeadlineMs defaults to 45s and is overridable, so it can never silently exceed the platform limit', () => {
  assert.equal(loadConfig({}).pollDeadlineMs, 45000);
  assert.equal(loadConfig({ GHA_POLL_DEADLINE_MS: '120000' }).pollDeadlineMs, 120000);
  assert.equal(loadConfig({ GHA_POLL_DEADLINE_MS: 'not-a-number' }).pollDeadlineMs, 45000);
});

test('the passphrase and the public override are read from the environment', () => {
  const cfg = loadConfig({ GHA_PASSWORD: 'secret', GHA_ALLOW_PUBLIC: '1' });
  assert.equal(cfg.password, 'secret');
  assert.equal(cfg.allowPublic, true);
});

test('there is no password and no public override by default', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.password, null);
  assert.equal(cfg.allowPublic, false);
});

// ---------------------------------------------------------------------
// secureCookies / exposedBeyondLoopback: cookie security and the passphrase
// floor must be decided by how the app is actually reachable, not by which
// hosting provider set VERCEL. See server.js's `assertSafeToStart` for the
// other half of this (the passphrase-floor gate that reads
// `exposedBeyondLoopback` and `secureCookies`).
// ---------------------------------------------------------------------

test('neither VERCEL nor GHA_ALLOWED_HOSTS: not exposed, cookies default to insecure', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.exposedBeyondLoopback, false);
  assert.equal(cfg.secureCookies, false);
});

test('VERCEL set: exposed, cookies default to secure', () => {
  const cfg = loadConfig({ VERCEL: '1' });
  assert.equal(cfg.exposedBeyondLoopback, true);
  assert.equal(cfg.secureCookies, true);
});

test('GHA_ALLOWED_HOSTS set without VERCEL (self-hosted behind a proxy): exposed, cookies default to secure', () => {
  const cfg = loadConfig({ GHA_ALLOWED_HOSTS: 'analytics.example.com' });
  assert.equal(cfg.serverless, false);
  assert.equal(cfg.exposedBeyondLoopback, true);
  assert.equal(cfg.secureCookies, true);
});

test('GHA_ALLOWED_HOSTS made entirely of blanks/commas does not count as exposed', () => {
  const cfg = loadConfig({ GHA_ALLOWED_HOSTS: ' , , ' });
  assert.deepEqual(cfg.allowedHosts, []);
  assert.equal(cfg.exposedBeyondLoopback, false);
  assert.equal(cfg.secureCookies, false);
});

test('GHA_SECURE_COOKIES=0 overrides the secure default to false even when VERCEL is set', () => {
  const cfg = loadConfig({ VERCEL: '1', GHA_SECURE_COOKIES: '0' });
  assert.equal(cfg.exposedBeyondLoopback, true, 'the underlying exposure signal is unaffected by the override');
  assert.equal(cfg.secureCookies, false);
});

test('GHA_SECURE_COOKIES=false (word form) overrides the same way', () => {
  const cfg = loadConfig({ VERCEL: '1', GHA_SECURE_COOKIES: 'false' });
  assert.equal(cfg.secureCookies, false);
});

test('GHA_SECURE_COOKIES=1 forces secure cookies on with neither VERCEL nor GHA_ALLOWED_HOSTS set', () => {
  const cfg = loadConfig({ GHA_SECURE_COOKIES: '1' });
  assert.equal(cfg.exposedBeyondLoopback, false, 'the override does not retroactively make the app "exposed"');
  assert.equal(cfg.secureCookies, true);
});

test('an empty GHA_SECURE_COOKIES falls back to the exposure-based default rather than forcing a value', () => {
  assert.equal(loadConfig({ VERCEL: '1', GHA_SECURE_COOKIES: '' }).secureCookies, true);
  assert.equal(loadConfig({ GHA_SECURE_COOKIES: '' }).secureCookies, false);
});
