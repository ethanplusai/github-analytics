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
import { createAuth } from './src/auth.js';
import { renderLoginPage } from './src/login-page.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'web');

// Fixed delay after a failed login, in milliseconds. Serverless instances
// share no memory, so there is no rate limiter to lean on here — this
// constant-time penalty is the only thing that costs an online attacker
// anything per guess. Injectable via `sleep` so tests don't have to pay it.
const FAILED_LOGIN_DELAY_MS = 400;

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Read a `application/x-www-form-urlencoded` body, bounded the same way
// `readJsonBody` in src/http.js bounds a JSON body: accumulate, reject past
// a size limit, destroy the socket rather than keep buffering. Kept local to
// server.js (rather than added to http.js) because it's login-form-specific
// and this task isn't touching http.js.
function readFormBody(req, { limit = 1_000_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > limit) {
        const err = new Error('Request body too large');
        err.code = 'TOO_LARGE';
        setImmediate(() => req.destroy());
        fail(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (err) => {
      fail(err);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

export function createApp({
  config, tokenInfo, client, store, poller, version,
  auth = createAuth({ passphrase: null }),
  sleep = defaultSleep,
}) {
  const api = createApi({ store, poller, client, tokenInfo, config, version });
  const serveStatic = createStaticHandler({ root: PUBLIC_DIR });

  async function requestListener(req, res) {
    try {
      if (!isRequestLocal(req, { extraHosts: config.allowedHosts ?? [] })) {
        sendError(res, 403, 'forbidden_host', 'This server only accepts requests from the local machine.');
        return;
      }

      // Parsed once and reused everywhere below, so there is exactly one
      // notion of "what path is this request for" in this handler — the raw
      // req.url must never be re-tested separately (e.g. with
      // startsWith('/api/')), or the two checks can drift apart.
      const url = new URL(req.url, 'http://localhost');

      if (auth.enabled) {
        const secure = Boolean(config.secureCookies);

        if (url.pathname === '/login') {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderLoginPage({}));
            return;
          }
          if (req.method === 'POST') {
            let params;
            try {
              params = await readFormBody(req);
            } catch (err) {
              const code = err.code === 'TOO_LARGE' ? 'too_large' : 'bad_request';
              sendError(res, err.code === 'TOO_LARGE' ? 413 : 400, code, err.message);
              return;
            }
            const candidate = params.get('password') ?? '';
            if (auth.checkPassphrase(candidate)) {
              res.writeHead(303, { location: '/', 'set-cookie': auth.issueCookie({ secure }) });
              res.end();
            } else {
              await sleep(FAILED_LOGIN_DELAY_MS);
              res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
              res.end(renderLoginPage({ error: 'Incorrect passphrase.' }));
            }
            return;
          }
          sendError(res, 404, 'not_found', 'Not found.');
          return;
        }

        if (url.pathname === '/logout' && req.method === 'POST') {
          res.writeHead(303, { location: '/login', 'set-cookie': auth.clearCookie({ secure }) });
          res.end();
          return;
        }

        // Vercel Cron sends no cookie — it authenticates GET /api/poll with
        // its own bearer secret, which src/api.js already checks. Sending
        // cron a 303 to /login would silently stop polling forever, so this
        // one route is exempt from the session gate. Only the GET: a POST
        // to /api/poll carries no secret check of its own in src/api.js, so
        // it must still go through this gate.
        const isCron = req.method === 'GET' && url.pathname === '/api/poll';

        if (!isCron && !auth.isAuthenticated(req, { secure })) {
          if (url.pathname.startsWith('/api/')) {
            sendError(res, 401, 'unauthorized', 'Sign in to use this API.');
          } else {
            res.writeHead(303, { location: '/login' });
            res.end();
          }
          return;
        }
      }

      if (await api.handle(req, res)) return;
      if (url.pathname.startsWith('/api/')) {
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

// Two startup refusals, kept as a standalone function so they're testable
// without spinning up the whole process. Both name the exact env vars an
// operator needs to set.
export function assertSafeToStart(config, auth) {
  // Decided by how the app is actually reachable (Vercel, or self-hosted
  // behind a proxy with GHA_ALLOWED_HOSTS set — see `exposedBeyondLoopback`
  // in src/config.js), not by `config.serverless` alone. A loopback-only
  // local instance is exempt from both checks below; anything reachable
  // beyond loopback is not, regardless of which of the two shapes it is.
  const exposed = config.exposedBeyondLoopback;
  if (exposed && !auth.enabled && !config.allowPublic) {
    throw new Error(
      'Refusing to start: this deployment would be public and has no passphrase. '
      + 'Set GHA_PASSWORD, or set GHA_ALLOW_PUBLIC=1 if you really intend a public dashboard.',
    );
  }
  // Measured on the module's own notion of the passphrase (trimmed), not
  // the raw env value — otherwise GHA_PASSWORD='abc' padded with 20 trailing
  // spaces would satisfy a raw-length check while the effective secret
  // stayed 3 characters. See src/auth.js's `effectiveLength`.
  if (exposed && auth.enabled && auth.effectiveLength < 20) {
    throw new Error(
      'Refusing to start: GHA_PASSWORD is shorter than 20 characters. This is deliberate: '
      + 'an instance reachable beyond loopback has no rate limiting on login attempts, so '
      + 'passphrase entropy is the actual control. Set GHA_PASSWORD to a generated random value '
      + 'of at least 20 characters, or unset GHA_PASSWORD entirely (pairing that with '
      + 'GHA_ALLOW_PUBLIC=1) if a genuinely public dashboard is what you intend.',
    );
  }
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

// Every bit of wiring that turns a bare config into a runnable app: load the
// config, discover a token, stand up the store and poller, and hand it all
// to createApp for a requestListener. Shared verbatim by main() (the local,
// long-lived process) and the default export below (the Vercel Function
// entrypoint) so the two paths cannot drift apart. Startup refusals run
// synchronously, before the first `await`, so a rejection here always means
// "never built a listener" — never a half-wired app.
export async function buildApp() {
  const config = loadConfig();
  const auth = createAuth({ passphrase: config.password });
  assertSafeToStart(config, auth);

  const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;

  const { token, source } = await discoverToken();
  const tokenInfo = { token, source, login: null, error: null };

  const store = new Store(await createDriverFromConfig(config));
  const client = token ? new GitHubClient({ token, baseUrl: config.apiBaseUrl }) : null;
  const poller = new Poller({ store, client, logger: console });
  poller.intervalHours = config.pollIntervalHours;

  const { requestListener } = createApp({ config, tokenInfo, client, store, poller, version, auth });

  return { config, auth, version, tokenInfo, store, client, poller, requestListener };
}

export async function main() {
  const {
    config, tokenInfo, store, client, poller, requestListener,
  } = await buildApp();

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
  if (tokenInfo.token) {
    lines.push(`  token: ${tokenInfo.source}   ·   data: ${dataLabel}`);
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

// The Vercel Function entrypoint. Vercel builds this module expecting a
// default export shaped `(req, res) => ...` — declaring `"functions":
// { "server.js": {...} }` in vercel.json (needed for maxDuration and
// includeFiles) opts this file into that contract, so it must actually
// satisfy it: no top-level `listen()`, and a default export that is a
// function.
//
// `appPromise` is cached at module scope — the module stays loaded across
// invocations on a warm instance — so the app is wired up once per instance
// and every request after the first reuses it, rather than each request
// opening its own store and driver. Concurrent first requests share the
// same in-flight promise for the same reason.
//
// A failed build must not poison the instance forever: resetting
// `appPromise` to null in the catch means the NEXT request tries again from
// scratch, rather than every future request replaying the same rejection.
let appPromise = null;

export default async function handler(req, res) {
  appPromise ??= buildApp();
  let app;
  try {
    app = await appPromise;
  } catch (err) {
    appPromise = null;
    console.error('[vercel] failed to initialize app:', err.message);
    if (!res.headersSent) {
      sendError(res, 500, 'internal_error', err.message);
    } else {
      res.end();
    }
    return;
  }
  return app.requestListener(req, res);
}

const invokedDirectly = process.argv[1] && /(^|[\\/])(server\.js|start\.js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n  GitHub Analytics could not start: ${err.message}\n`);
    process.exit(1);
  });
}
