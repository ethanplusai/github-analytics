import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp, listenWithFallback, createShutdownHandler, createDriverFromConfig, bannerUrl, assertSafeToStart } from '../server.js';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';
import { Poller } from '../src/poller.js';
import { createAuth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const CONFIG = {
  dataDir: '/tmp/gha-test', dbPath: ':memory:', host: '127.0.0.1', port: 0,
  pollIntervalHours: 6, autoSeed: false, autoOpen: false, envToken: null,
  apiBaseUrl: 'https://api.github.com', allowedHosts: [],
};

// A no-op sleep so tests exercising the failed-login path don't pay the real
// fixed delay.
const NO_SLEEP = () => Promise.resolve();

async function withApp(fn, {
  client = null,
  tokenInfo = { token: 't', source: 'test', login: 'octo' },
  auth,
  sleep,
  config: configOverrides = {},
} = {}) {
  const store = new Store(createSqliteDriver(':memory:'));
  const poller = new Poller({ store, client, now: () => new Date('2026-09-04T12:00:00Z') });
  const { requestListener } = createApp({
    config: { ...CONFIG, ...configOverrides }, tokenInfo, client, store, poller, version: '1.0.0', auth, sleep,
  });
  const server = createServer(requestListener);
  const port = await listenWithFallback(server, { host: '127.0.0.1', port: 0 });
  try { await fn(`http://127.0.0.1:${port}`, { store, poller }); } finally { await new Promise((r) => server.close(r)); }
}

test('GET / serves the app shell', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>GitHub Analytics<\/title>/);
    assert.match(html, /id="app-root"/);
    assert.match(html, /src="\/app\.js"/);
    assert.match(html, /href="\/styles\.css"/);
  });
});

test('a client-side route falls back to the app shell', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/repo/octo/hello`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="app-root"/);
  });
});

test('the API is mounted on the same origin as the app', async () => {
  await withApp(async (base) => {
    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).token.present, true);
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  });
});

test('a request with a foreign Host header is rejected', async () => {
  // Node's fetch silently drops a `host` override, so this one goes through node:http directly.
  const { request } = await import('node:http');
  await withApp(async (base) => {
    const { port } = new URL(base);
    const { status, body } = await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/status', method: 'GET', headers: { Host: 'evil.example.com' } },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.equal(JSON.parse(body).error.code, 'forbidden_host');
  });
});

test('an unknown API route is a JSON 404, not the app shell', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});

test('listenWithFallback moves past a port that is already taken', async () => {
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;

  const server = createServer(() => {});
  const port = await listenWithFallback(server, { host: '127.0.0.1', port: taken, attempts: 5 });
  assert.notEqual(port, taken);
  assert.ok(port > taken && port <= taken + 5);

  await new Promise((r) => server.close(r));
  await new Promise((r) => blocker.close(r));
});

test('a second interrupt during shutdown does not re-enter the graceful path', async () => {
  // Exercise the guard directly rather than signalling a real process.
  let closes = 0;
  let exits = 0;
  const shutdown = createShutdownHandler({
    poller: { stop() {} },
    server: { close(cb) { closes += 1; setTimeout(cb, 50); } },
    store: { close() {} },
    exit: () => { exits += 1; },
  });
  shutdown();
  shutdown();
  assert.equal(closes, 1, 'the server is only closed once');
  assert.equal(exits, 1, 'the second signal exits immediately');
});

test('listenWithFallback gives up with a clear error after all attempts', async () => {
  const blockers = [];
  const base = 45990;
  for (let i = 0; i < 3; i += 1) {
    const s = createServer(() => {});
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r, j) => { s.once('error', j); s.listen(base + i, '127.0.0.1', r); });
    blockers.push(s);
  }
  const server = createServer(() => {});
  await assert.rejects(
    () => listenWithFallback(server, { host: '127.0.0.1', port: base, attempts: 2 }),
    /No free port/,
  );
  for (const s of blockers) await new Promise((r) => s.close(r));
});

test('the frontend assets are served', async () => {
  await withApp(async (base) => {
    for (const [path, type] of [
      ['/styles.css', /text\/css/],
      ['/app.js', /javascript/],
      ['/charts.js', /javascript/],
      ['/ui.js', /javascript/],
      ['/api.js', /javascript/],
      ['/views/home.js', /javascript/],
      ['/favicon.svg', /image\/svg/],
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} should be served`);
      assert.match(res.headers.get('content-type'), type, path);
    }
  });
});

test('the repo detail view module is served', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/views/repo.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
  });
});

test('the manage panel module is served', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/views/manage.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
  });
});

test('createDriverFromConfig picks sqlite when no postgresUrl is configured', async () => {
  const driver = await createDriverFromConfig({ ...CONFIG, postgresUrl: null });
  try {
    assert.equal(driver.dialect, 'sqlite');
  } finally {
    await driver.close();
  }
});

test('bannerUrl builds a loopback URL when not serverless', () => {
  const url = bannerUrl({ ...CONFIG, serverless: false, host: '127.0.0.1' }, 4319, {});
  assert.equal(url, 'http://127.0.0.1:4319');
});

test('bannerUrl uses VERCEL_URL when serverless and it is set', () => {
  const url = bannerUrl({ ...CONFIG, serverless: true }, 3000, { VERCEL_URL: 'my-app-abc123.vercel.app' });
  assert.equal(url, 'https://my-app-abc123.vercel.app');
});

test('bannerUrl omits the URL when serverless with no VERCEL_URL, rather than print the bind address', () => {
  const url = bannerUrl({ ...CONFIG, serverless: true, host: '0.0.0.0' }, 3000, {});
  assert.equal(url, null);
});

test('no HTML in the app declares a modal dialog', async () => {
  await withApp(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /<dialog/i);
    assert.doesNotMatch(html, /role="dialog"/i);
  });
});

// ---------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------

const AUTH_ON = createAuth({ passphrase: 'a-long-test-passphrase-1234567890' });

test('with auth enabled, an unauthenticated API request is refused with 401 JSON', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/status`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.error.code, 'unauthorized');
  }, { auth: AUTH_ON });
});

test('with auth enabled, an unauthenticated page request redirects to /login', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
  }, { auth: AUTH_ON });
});

test('with auth enabled, the dashboard HTML is NOT served without a cookie', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    const body = await res.text();
    assert.doesNotMatch(body, /id="app-root"/);
  }, { auth: AUTH_ON });
});

test('GET /api/poll bypasses the session gate (cron has no cookie)', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/poll`, { headers: { authorization: 'Bearer shh' } });
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 303);
  }, { auth: AUTH_ON, config: { cronSecret: 'shh' } });
});

test('POST /api/poll (no bearer secret) IS gated when auth is enabled', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/poll`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'unauthorized');
  }, { auth: AUTH_ON, config: { cronSecret: 'shh' } });
});

test('GET /login serves the login page when auth is enabled', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/login`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /name="password"/);
    assert.match(html, /action="\/login"/);
  }, { auth: AUTH_ON });
});

test('POST /login with the wrong passphrase does not set a cookie', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
    });
    assert.notEqual(res.status, 303);
    assert.equal(res.headers.getSetCookie().length, 0);
  }, { auth: AUTH_ON, sleep: NO_SLEEP });
});

test('POST /login with the right passphrase sets the cookie and redirects to /', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=a-long-test-passphrase-1234567890',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.match(cookies[0], /HttpOnly/);
  }, { auth: AUTH_ON, sleep: NO_SLEEP });
});

test('a valid session cookie reaches the dashboard and the API', async () => {
  await withApp(async (base) => {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=a-long-test-passphrase-1234567890',
    });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];

    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="app-root"/);

    const api = await fetch(`${base}/api/status`, { headers: { cookie } });
    assert.equal(api.status, 200);
  }, { auth: AUTH_ON, sleep: NO_SLEEP });
});

test('POST /logout clears the cookie', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.match(cookies[0], /Max-Age=0/);
  }, { auth: AUTH_ON });
});

test('with auth DISABLED the request path is unchanged', async () => {
  await withApp(async (base) => {
    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200);
    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 404);
  });
});

test('a session cookie with the wrong name for the mode (plain cookie while serverless) is refused', async () => {
  await withApp(async (base) => {
    // Issue a plain-name cookie directly from the auth module (bypassing the
    // server's own login route, which would always pick the right name for
    // the mode) to prove the server actually threads `{ secure }` into
    // isAuthenticated rather than relying on its permissive default.
    const cookie = AUTH_ON.issueCookie({ secure: false }).split(';')[0];
    const res = await fetch(`${base}/api/status`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 401);
  }, { auth: AUTH_ON, config: { serverless: true, secureCookies: true } });
});

test('startup refuses a short passphrase in serverless mode, so entropy stands in for rate limiting', () => {
  const shortAuth = createAuth({ passphrase: 'too-short' });
  assert.throws(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: 'too-short', allowPublic: false }, shortAuth),
    /20 characters/,
  );
});

test('startup does not refuse a long passphrase in serverless mode', () => {
  const longPass = 'a-long-test-passphrase-1234567890';
  const longAuth = createAuth({ passphrase: longPass });
  assert.doesNotThrow(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: longPass, allowPublic: false }, longAuth),
  );
});

test('startup refuses a public serverless deployment with no passphrase', () => {
  const off = createAuth({ passphrase: null });
  assert.throws(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: null, allowPublic: false }, off),
    /GHA_PASSWORD/,
  );
});

test('startup does not refuse locally with no passphrase', () => {
  const off = createAuth({ passphrase: null });
  assert.doesNotThrow(
    () => assertSafeToStart({ ...CONFIG, serverless: false, exposedBeyondLoopback: false, password: null, allowPublic: false }, off),
  );
});

test('startup does not refuse a public serverless deployment when explicitly allowed', () => {
  const off = createAuth({ passphrase: null });
  assert.doesNotThrow(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: null, allowPublic: true }, off),
  );
});

// Regression: the 20-character floor must be measured on the passphrase
// that auth.js actually accepts (trimmed), not the raw env value — a
// short secret padded with whitespace must still be refused.

test('startup refuses a passphrase padded to 20+ chars with TRAILING whitespace', () => {
  const padded = 'abc' + ' '.repeat(20); // 23 raw chars, 3 effective
  const auth = createAuth({ passphrase: padded });
  assert.throws(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: padded, allowPublic: false }, auth),
    /20 characters/,
  );
});

test('startup refuses a passphrase padded to 20+ chars with LEADING whitespace', () => {
  const padded = ' '.repeat(20) + 'abc';
  const auth = createAuth({ passphrase: padded });
  assert.throws(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: padded, allowPublic: false }, auth),
    /20 characters/,
  );
});

test('startup refuses a passphrase padded to 20+ chars with BOTH leading and trailing whitespace', () => {
  const padded = '   ' + 'abc' + ' '.repeat(20);
  const auth = createAuth({ passphrase: padded });
  assert.throws(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: padded, allowPublic: false }, auth),
    /20 characters/,
  );
});

test('a whitespace-only passphrase is treated as no passphrase, so serverless refuses as public rather than starting quietly', () => {
  const whitespaceOnly = ' '.repeat(25);
  const auth = createAuth({ passphrase: whitespaceOnly });
  assert.equal(auth.enabled, false, 'a whitespace-only passphrase must not enable auth');
  assert.throws(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: whitespaceOnly, allowPublic: false }, auth),
    /GHA_PASSWORD/,
    'must hit the "no passphrase configured" refusal, not silently allow a public server',
  );
});

test('a genuine 20+ character passphrase (no padding trickery) still starts normally', () => {
  const real = 'genuinely-twenty-char-plus-passphrase';
  const auth = createAuth({ passphrase: real });
  assert.doesNotThrow(
    () => assertSafeToStart({ ...CONFIG, serverless: true, exposedBeyondLoopback: true, password: real, allowPublic: false }, auth),
  );
});

// ---------------------------------------------------------------------
// FIX 1 regression: cookie security and the passphrase floor must be
// decided by whether the app is reachable beyond loopback, not by whether
// it happens to be running on Vercel. A self-hosted deployment behind an
// nginx/Caddy proxy (GHA_ALLOWED_HOSTS set, VERCEL unset) is exactly as
// public as a Vercel deployment.
// ---------------------------------------------------------------------

test('REGRESSION: a 7-character passphrase behind GHA_ALLOWED_HOSTS with no VERCEL must refuse to start', () => {
  const config = loadConfig({ GHA_PASSWORD: 'shortpw', GHA_ALLOWED_HOSTS: 'analytics.example.com' });
  assert.equal(config.serverless, false, 'sanity check: VERCEL is not set in this scenario');
  assert.equal(config.exposedBeyondLoopback, true, 'a non-empty GHA_ALLOWED_HOSTS must count as exposed');
  const auth = createAuth({ passphrase: config.password });
  assert.throws(
    () => assertSafeToStart(config, auth),
    /20 characters/,
  );
});

const LONG_PASSPHRASE = 'a-genuinely-long-passphrase-1234567890';

test('assertSafeToStart via loadConfig: VERCEL set, short passphrase, no GHA_ALLOWED_HOSTS -> refuses', () => {
  const config = loadConfig({ VERCEL: '1', GHA_PASSWORD: 'shortpw' });
  const auth = createAuth({ passphrase: config.password });
  assert.throws(() => assertSafeToStart(config, auth), /20 characters/);
});

test('assertSafeToStart via loadConfig: GHA_ALLOWED_HOSTS set, short passphrase, no VERCEL -> refuses (the regression scenario, generalised)', () => {
  const config = loadConfig({ GHA_ALLOWED_HOSTS: 'analytics.example.com', GHA_PASSWORD: 'shortpw' });
  const auth = createAuth({ passphrase: config.password });
  assert.throws(() => assertSafeToStart(config, auth), /20 characters/);
});

test('assertSafeToStart via loadConfig: neither VERCEL nor GHA_ALLOWED_HOSTS, short passphrase -> starts fine (loopback-only)', () => {
  const config = loadConfig({ GHA_PASSWORD: 'shortpw' });
  const auth = createAuth({ passphrase: config.password });
  assert.doesNotThrow(() => assertSafeToStart(config, auth));
});

test('assertSafeToStart via loadConfig: neither VERCEL nor GHA_ALLOWED_HOSTS, no passphrase at all -> starts fine, no refusal', () => {
  const config = loadConfig({});
  const auth = createAuth({ passphrase: config.password });
  assert.equal(auth.enabled, false);
  assert.doesNotThrow(() => assertSafeToStart(config, auth));
});

test('assertSafeToStart via loadConfig: GHA_ALLOWED_HOSTS set, no passphrase, no GHA_ALLOW_PUBLIC -> refuses (self-hosted public-with-no-boundary case)', () => {
  const config = loadConfig({ GHA_ALLOWED_HOSTS: 'analytics.example.com' });
  const auth = createAuth({ passphrase: config.password });
  assert.throws(() => assertSafeToStart(config, auth), /GHA_PASSWORD/);
});

test('assertSafeToStart via loadConfig: GHA_ALLOWED_HOSTS set, no passphrase, GHA_ALLOW_PUBLIC=1 -> starts (operator relying on proxy auth instead)', () => {
  const config = loadConfig({ GHA_ALLOWED_HOSTS: 'analytics.example.com', GHA_ALLOW_PUBLIC: '1' });
  const auth = createAuth({ passphrase: config.password });
  assert.doesNotThrow(() => assertSafeToStart(config, auth));
});

test('GHA_SECURE_COOKIES forcing secure=true locally still lets a short passphrase start (the override only affects cookies, not exposure)', () => {
  const config = loadConfig({ GHA_SECURE_COOKIES: '1', GHA_PASSWORD: 'shortpw' });
  assert.equal(config.secureCookies, true);
  assert.equal(config.exposedBeyondLoopback, false, 'no VERCEL and no GHA_ALLOWED_HOSTS: still not exposed');
  const auth = createAuth({ passphrase: config.password });
  assert.doesNotThrow(() => assertSafeToStart(config, auth));
});

test('GHA_SECURE_COOKIES forcing secure=false on Vercel does not relax the passphrase floor', () => {
  const config = loadConfig({ VERCEL: '1', GHA_SECURE_COOKIES: '0', GHA_PASSWORD: 'shortpw' });
  assert.equal(config.secureCookies, false);
  const auth = createAuth({ passphrase: config.password });
  assert.throws(() => assertSafeToStart(config, auth), /20 characters/);
});

// End-to-end: the cookie the server actually issues carries the flags
// `config.secureCookies` says it should, for each of the two public shapes.

test('end-to-end: VERCEL set issues a Secure, __Host-prefixed cookie', async () => {
  const config = loadConfig({ VERCEL: '1', GHA_PASSWORD: LONG_PASSPHRASE });
  const auth = createAuth({ passphrase: config.password });
  await withApp(async (base) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(LONG_PASSPHRASE)}`,
    });
    const cookie = res.headers.getSetCookie()[0];
    assert.match(cookie, /^__Host-gha_session=/);
    assert.match(cookie, /Secure/);
  }, { auth, sleep: NO_SLEEP, config });
});

test('end-to-end: GHA_ALLOWED_HOSTS set with no VERCEL ALSO issues a Secure, __Host-prefixed cookie (the fix)', async () => {
  const config = loadConfig({ GHA_ALLOWED_HOSTS: 'analytics.example.com', GHA_PASSWORD: LONG_PASSPHRASE });
  assert.equal(config.serverless, false);
  const auth = createAuth({ passphrase: config.password });
  await withApp(async (base) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(LONG_PASSPHRASE)}`,
    });
    const cookie = res.headers.getSetCookie()[0];
    assert.match(cookie, /^__Host-gha_session=/);
    assert.match(cookie, /Secure/);
  }, { auth, sleep: NO_SLEEP, config });
});

test('end-to-end: neither VERCEL nor GHA_ALLOWED_HOSTS issues a plain, non-Secure cookie (local behaviour unchanged)', async () => {
  const config = loadConfig({ GHA_PASSWORD: LONG_PASSPHRASE });
  const auth = createAuth({ passphrase: config.password });
  await withApp(async (base) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(LONG_PASSPHRASE)}`,
    });
    const cookie = res.headers.getSetCookie()[0];
    assert.match(cookie, /^gha_session=/);
    assert.doesNotMatch(cookie, /__Host-/);
    assert.doesNotMatch(cookie, /Secure/);
  }, { auth, sleep: NO_SLEEP, config });
});

test('local behaviour with no GHA_PASSWORD and no GHA_ALLOWED_HOSTS is completely unchanged: no login, no cookie, no redirect', async () => {
  const config = loadConfig({});
  const auth = createAuth({ passphrase: config.password });
  assert.equal(auth.enabled, false);
  await withApp(async (base) => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.getSetCookie().length, 0);
    const loginPage = await fetch(`${base}/login`);
    assert.equal(loginPage.status, 404, '/login does not exist when auth is disabled');
  }, { auth, config });
});

// ---------------------------------------------------------------------
// FIX 2: the too-short-passphrase refusal must explain BOTH ways out when
// GHA_ALLOW_PUBLIC=1 is already set — lengthening isn't the only option the
// operator asked for.
// ---------------------------------------------------------------------

test('FIX 2: the short-passphrase refusal explains both lengthening AND unsetting GHA_PASSWORD when GHA_ALLOW_PUBLIC=1', () => {
  const config = loadConfig({ VERCEL: '1', GHA_PASSWORD: 'shortpw', GHA_ALLOW_PUBLIC: '1' });
  const auth = createAuth({ passphrase: config.password });
  assert.throws(
    () => assertSafeToStart(config, auth),
    (err) => {
      assert.match(err.message, /20 characters/);
      assert.match(err.message, /unset GHA_PASSWORD/i);
      assert.match(err.message, /GHA_ALLOW_PUBLIC/);
      return true;
    },
  );
});
