#!/usr/bin/env node
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { loadConfig } from './src/config.js';
import { discoverToken } from './src/token.js';
import { openDatabase } from './src/db.js';
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

export function createShutdownHandler({ poller, server, store, exit = process.exit, forceMs = 2000 }) {
  let shuttingDown = false;
  return function shutdown() {
    if (shuttingDown) {
      exit(0);
      return;
    }
    shuttingDown = true;
    poller.stop();
    server.close(() => {
      store.close();
      exit(0);
    });
    setTimeout(() => exit(0), forceMs).unref();
  };
}

export async function main() {
  const config = loadConfig();
  config.allowedHosts = (process.env.GHA_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;

  const { token, source } = await discoverToken();
  const tokenInfo = { token, source, login: null, error: null };

  const store = new Store(openDatabase(config.dbPath));
  const client = token ? new GitHubClient({ token, baseUrl: config.apiBaseUrl }) : null;
  const poller = new Poller({ store, client, logger: console });
  poller.intervalHours = config.pollIntervalHours;

  const { requestListener } = createApp({ config, tokenInfo, client, store, poller, version });

  const server = createServer(requestListener);
  const boundPort = await listenWithFallback(server, config);

  const url = `http://${config.host}:${boundPort}`;
  const lines = [
    '  GitHub Analytics',
    `  → ${url}`,
  ];
  if (token) {
    lines.push(`  token: ${source}   ·   data: ${config.dbPath}`);
    lines.push('  Collecting traffic in the background. Press Ctrl+C to stop.');
  } else {
    lines.push("  token: none found — run 'gh auth login' or set GITHUB_TOKEN, then restart");
  }
  console.log(lines.join('\n'));

  if (config.autoOpen) openBrowser(url);

  client?.getViewer().then((u) => { tokenInfo.login = u.login; }).catch((err) => { tokenInfo.error = err.message; });
  poller.bootstrap({ autoSeed: config.autoSeed }).catch((err) => console.error('[poll]', err.message));
  poller.start(config.pollIntervalHours);

  const shutdown = createShutdownHandler({ poller, server, store });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, shutdown);
  }
}

const invokedDirectly = process.argv[1] && /(^|[\\/])(server\.js|start\.js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n  GitHub Analytics could not start: ${err.message}\n`);
    process.exit(1);
  });
}
