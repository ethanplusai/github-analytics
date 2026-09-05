import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRouter, sendJson, sendError, readJsonBody,
  createStaticHandler, isRequestLocal, matchPattern,
} from '../src/http.js';

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('matchPattern extracts named parameters', () => {
  assert.deepEqual(matchPattern('/api/repos/:owner/:name', '/api/repos/octo/hello'), { owner: 'octo', name: 'hello' });
  assert.equal(matchPattern('/api/repos/:owner/:name', '/api/repos/octo'), null);
  assert.equal(matchPattern('/api/repos/:owner/:name', '/api/repos/octo/hello/extra'), null);
  assert.deepEqual(matchPattern('/api/status', '/api/status'), {});
});

test('matchPattern decodes percent-encoded parameters', () => {
  assert.deepEqual(matchPattern('/x/:v', '/x/a%2Fb'), { v: 'a/b' });
});

test('the router dispatches by method, pattern, and query', async () => {
  const router = createRouter();
  router.get('/api/hello/:who', async (req, res, ctx) => {
    sendJson(res, 200, { who: ctx.params.who, loud: ctx.query.loud ?? null });
  });
  router.post('/api/echo', async (req, res) => {
    sendJson(res, 201, { got: await readJsonBody(req) });
  });

  await withServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    sendError(res, 404, 'not_found', 'no route');
  }, async (base) => {
    const a = await fetch(`${base}/api/hello/world?loud=yes`);
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { who: 'world', loud: 'yes' });

    const b = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 1 }),
    });
    assert.equal(b.status, 201);
    assert.deepEqual(await b.json(), { got: { n: 1 } });

    const c = await fetch(`${base}/api/nope`);
    assert.equal(c.status, 404);
    assert.deepEqual(await c.json(), { error: { code: 'not_found', message: 'no route' } });

    const d = await fetch(`${base}/api/hello/world`, { method: 'DELETE' });
    assert.equal(d.status, 404);
  });
});

test('a handler that throws becomes a 500 rather than a hung socket', async () => {
  const router = createRouter();
  router.get('/api/boom', async () => { throw new Error('kaboom'); });
  await withServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    sendError(res, 404, 'not_found', 'no route');
  }, async (base) => {
    const res = await fetch(`${base}/api/boom`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'internal_error');
  });
});

test('readJsonBody rejects malformed and oversized bodies', async () => {
  const router = createRouter();
  router.post('/api/x', async (req, res) => {
    try {
      sendJson(res, 200, await readJsonBody(req, { limit: 20 }));
    } catch (err) {
      sendError(res, 400, err.code, err.message);
    }
  });
  await withServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    sendError(res, 404, 'not_found', 'x');
  }, async (base) => {
    const bad = await fetch(`${base}/api/x`, { method: 'POST', body: 'not json' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'BAD_JSON');

    const big = await fetch(`${base}/api/x`, { method: 'POST', body: JSON.stringify({ a: 'x'.repeat(100) }) });
    assert.equal(big.status, 400);
    assert.equal((await big.json()).error.code, 'TOO_LARGE');
  });
});

test('the static handler serves files, falls back to index.html, and blocks traversal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gha-static-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>App</title>');
  writeFileSync(join(root, 'styles.css'), 'body{color:red}');
  writeFileSync(join(tmpdir(), 'secret.txt'), 'do not serve me');

  const serveStatic = createStaticHandler({ root });
  await withServer(async (req, res) => {
    if (await serveStatic(req, res)) return;
    sendError(res, 404, 'not_found', 'x');
  }, async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /<title>App<\/title>/);

    const css = await fetch(`${base}/styles.css`);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal(await css.text(), 'body{color:red}');

    const spa = await fetch(`${base}/repo/octo/hello`, { headers: { accept: 'text/html' } });
    assert.equal(spa.status, 200, 'unknown html route falls back to the app shell');
    assert.match(await spa.text(), /<title>App<\/title>/);

    const traversal = await fetch(`${base}/../secret.txt`);
    assert.notEqual(traversal.status, 200);
    const encoded = await fetch(`${base}/%2e%2e%2fsecret.txt`);
    assert.notEqual(encoded.status, 200);

    const missingAsset = await fetch(`${base}/missing.js`);
    assert.equal(missingAsset.status, 404, 'a missing asset is a 404, not the app shell');
  });
});

test('the static handler answers 304 for a matching ETag', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gha-etag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.html'), 'hello');
  writeFileSync(join(root, 'app.js'), 'export const a = 1;');
  const serveStatic = createStaticHandler({ root });
  await withServer(async (req, res) => {
    if (await serveStatic(req, res)) return;
    sendError(res, 404, 'not_found', 'x');
  }, async (base) => {
    const first = await fetch(`${base}/app.js`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
  });
});

test('isRequestLocal accepts loopback hosts on any port and rejects rebinding attempts', () => {
  const req = (headers) => ({ headers, method: 'GET' });
  assert.equal(isRequestLocal(req({ host: '127.0.0.1:4319' }), {}), true);
  assert.equal(isRequestLocal(req({ host: 'localhost:4319' }), {}), true);
  assert.equal(isRequestLocal(req({ host: '127.0.0.1:51234' }), {}), true, 'the port is not the guard');
  assert.equal(isRequestLocal(req({ host: '[::1]:4319' }), {}), true);
  assert.equal(isRequestLocal(req({ host: 'localhost' }), {}), true);
  assert.equal(isRequestLocal(req({ host: 'evil.example.com:4319' }), {}), false);
  assert.equal(isRequestLocal(req({}), {}), false, 'a missing Host header is refused');
  assert.equal(
    isRequestLocal(req({ host: 'analytics.example.com' }), { extraHosts: ['analytics.example.com'] }),
    true,
  );
});

test('isRequestLocal rejects a cross-origin write', () => {
  const post = { method: 'POST', headers: { host: '127.0.0.1:4319', origin: 'https://evil.example.com' } };
  assert.equal(isRequestLocal(post, {}), false);
  const same = { method: 'POST', headers: { host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' } };
  assert.equal(isRequestLocal(same, {}), true);
  const none = { method: 'POST', headers: { host: '127.0.0.1:4319' } };
  assert.equal(isRequestLocal(none, {}), true, 'a same-origin fetch sends no Origin on GET-like writes');
});

// A directory stats successfully (fs.promises.stat does not distinguish
// file vs. directory for our purposes) but fails when createReadStream
// actually tries to read it: Node reports EISDIR on the stream's 'error'
// event. This deterministically drives the exact failure path the fix in
// review Finding 1 targets — a stream error arriving *after* writeHead(200)
// has already gone out — without relying on a real TOCTOU race, which
// would be flaky. See task-5-report.md for why this replaces the
// literal "file disappears mid-stream" test suggested in review.
test('a read-stream error after headers are sent does not crash the server or hang the socket', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gha-streamerr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.html'), 'shell');
  mkdirSync(join(root, 'trap.bin'));

  const serveStatic = createStaticHandler({ root });
  let rejected = null;
  await withServer(async (req, res) => {
    try {
      if (await serveStatic(req, res)) return;
      sendError(res, 404, 'not_found', 'x');
    } catch (err) {
      rejected = err;
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'x');
    }
  }, async (base) => {
    const response = await fetch(`${base}/trap.bin`).catch((err) => err);
    if (response instanceof Response) {
      await response.arrayBuffer().catch(() => {});
    }
    assert.equal(rejected, null, 'serveStatic never rejects even when the read stream errors mid-flight');
  });
});

test('the host guard is case-insensitive', () => {
  assert.equal(isRequestLocal({ method: 'GET', headers: { host: 'LOCALHOST:4319' } }, {}), true);
  assert.equal(
    isRequestLocal({ method: 'GET', headers: { host: 'Analytics.Example.COM' } }, { extraHosts: ['analytics.example.com'] }),
    true,
  );
  assert.equal(isRequestLocal({ method: 'GET', headers: { host: 'EVIL.example.com' } }, {}), false);
});
