import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp, listenWithFallback, createShutdownHandler, createDriverFromConfig, bannerUrl } from '../server.js';
import { createSqliteDriver } from '../src/db/sqlite.js';
import { Store } from '../src/store.js';
import { Poller } from '../src/poller.js';

const CONFIG = {
  dataDir: '/tmp/gha-test', dbPath: ':memory:', host: '127.0.0.1', port: 0,
  pollIntervalHours: 6, autoSeed: false, autoOpen: false, envToken: null,
  apiBaseUrl: 'https://api.github.com', allowedHosts: [],
};

async function withApp(fn, { client = null, tokenInfo = { token: 't', source: 'test', login: 'octo' } } = {}) {
  const store = new Store(createSqliteDriver(':memory:'));
  const poller = new Poller({ store, client, now: () => new Date('2026-09-04T12:00:00Z') });
  const { requestListener } = createApp({
    config: CONFIG, tokenInfo, client, store, poller, version: '1.0.0',
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
