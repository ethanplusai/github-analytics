#!/usr/bin/env node
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { loadConfig } from './src/config.js';
import { discoverToken } from './src/token.js';
import { Store } from './src/store.js';
import { GitHubClient } from './src/github.js';
import { Poller } from './src/poller.js';
import { createApi } from './src/api.js';
import { createStaticHandler, isRequestLocal, sendError } from './src/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

export function createApp({ config, tokenInfo, client, store, poller, version }) {
  const api = createApi({ store, poller, client, tokenInfo, config, version });
  const serveStatic = createStaticHandler({ root: PUBLIC_DIR });

  async function requestListener(req, res) {
    try {
      if (!isRequestLocal(req, { extraHosts: config.allowedHosts ?? [] })) {
        sendError(res, 403, 'forbidden_host', 'This server only accepts requests from the local machine.');
        return;
      }
      if (await api.handle(req, res)) return;
      if (req.url.startsWith('/api/')) {
        sendError(res, 404, 'not_found', 'Unknown API route.');
        return;
      }
      if (await serveStatic(req, res)) return;
      sendError(res, 404, 'not_found', 'Not found.');
    } catch (err) {
      if (!res.headersSent) {
        console.error('[request]', err.message);
        sendError(res, 500, 'internal_error', err.message);
      } else {
        console.error('[request] error after headers sent:', err.message);
      }
    }
  }

  return { requestListener, router: api, serveStatic };
}

export function listenWithFallback(server, { host, port, attempts = 20 }) {
  return new Promise((resolvePromise, reject) => {
    let attempt = 0;

    const tryListen = (candidatePort) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && candidatePort !== 0 && attempt < attempts) {
          attempt += 1;
          tryListen(candidatePort + 1);
          return;
        }
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`No free port found between ${port} and ${port + attempts}`));
          return;
        }
        reject(err);
      };

      const onListening = () => {
        server.removeListener('error', onError);
        resolvePromise(server.address().port);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidatePort, host);
    };

    tryListen(port);
  });
}

export function openBrowser(url, { platform = process.platform, run = execFile } = {}) {
  try {
    if (platform === 'darwin') {
      run('open', [url], () => {});
    } else if (platform === 'win32') {
      run('cmd', ['/c', 'start', '', url], () => {});
    } else {
      run('xdg-open', [url], () => {});
    }
  } catch {
    // Failing to open a browser must never take the server down.
  }
}

// Off the loopback interface, `config.host` is meaningless — a serverless
// deployment binds `0.0.0.0` and is reached only through whatever host the
// platform puts in front of it. `process.env.VERCEL_URL` names that host on
// Vercel; with nothing to name it, the banner omits the URL line rather than
// print something untrue.
export function bannerUrl(config, boundPort, env = process.env) {
  if (config.serverless) {
    return env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null;
  }
  return `http://${config.host}:${boundPort}`;
}

export function createShutdownHandler({ poller, server, store, exit = process.exit, forceMs = 2000 }) {
  let shuttingDown = false;
  return function shutdown() {
    if (shuttingDown) {
      exit(0);
      return;
    }
    shuttingDown = true;
    poller.stop();
    server.close(async () => {
      await store.close();
      exit(0);
    });
    setTimeout(() => exit(0), forceMs).unref();
  };
}

export async function createDriverFromConfig(config) {
  if (config.postgresUrl) {
    const { createPostgresDriver } = await import('./src/db/postgres.js');
    return createPostgresDriver(config.postgresUrl);
  }
  const { createSqliteDriver } = await import('./src/db/sqlite.js');
  return createSqliteDriver(config.dbPath);
}

export async function main() {
  const config = loadConfig();

  const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;

  const { token, source } = await discoverToken();
  const tokenInfo = { token, source, login: null, error: null };

  const store = new Store(await createDriverFromConfig(config));
  const client = token ? new GitHubClient({ token, baseUrl: config.apiBaseUrl }) : null;
  const poller = new Poller({ store, client, logger: console });
  poller.intervalHours = config.pollIntervalHours;

  const { requestListener } = createApp({ config, tokenInfo, client, store, poller, version });

  const server = createServer(requestListener);
  let boundPort;
  if (config.serverless) {
    boundPort = await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', () => resolvePromise(server.address().port));
    });
  } else {
    boundPort = await listenWithFallback(server, config);
  }

  const url = bannerUrl(config, boundPort);
  const dataLabel = config.postgresUrl ? 'neon postgres' : config.dbPath;
  const lines = ['  GitHub Analytics'];
  if (url) lines.push(`  → ${url}`);
  if (token) {
    lines.push(`  token: ${source}   ·   data: ${dataLabel}`);
    lines.push('  Collecting traffic in the background. Press Ctrl+C to stop.');
  } else {
    lines.push("  token: none found — run 'gh auth login' or set GITHUB_TOKEN, then restart");
  }
  console.log(lines.join('\n'));

  if (config.autoOpen && !config.serverless) openBrowser(url);

  client?.getViewer().then((u) => { tokenInfo.login = u.login; }).catch((err) => { tokenInfo.error = err.message; });
  if (config.pollMode === 'cron') {
    console.log('  polling: cron mode — waiting for GET /api/poll');
  } else {
    poller.bootstrap({ autoSeed: config.autoSeed }).catch((err) => console.error('[poll]', err.message));
    poller.start(config.pollIntervalHours);
  }

  if (!config.serverless) {
    const shutdown = createShutdownHandler({ poller, server, store });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, shutdown);
    }
  }
}

const invokedDirectly = process.argv[1] && /(^|[\\/])(server\.js|start\.js)$/.test(process.argv[1]);
if (invokedDirectly || process.env.VERCEL) {
  main().catch((err) => {
    console.error(`\n  GitHub Analytics could not start: ${err.message}\n`);
    process.exit(1);
  });
}
