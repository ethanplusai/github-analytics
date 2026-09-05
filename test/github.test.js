import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, normaliseRepo } from '../src/github.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    async text() { return JSON.stringify(body); },
  };
}

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const key = new URL(String(url)).pathname + (new URL(String(url)).search || '');
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return typeof handler === 'function' ? handler(calls.length) : handler;
  };
  impl.calls = calls;
  return impl;
}

test('sends the token and the required headers', async () => {
  const fetchImpl = fakeFetch({ '/user': jsonResponse({ login: 'octo' }) });
  const client = new GitHubClient({ token: 'ghp_x', fetchImpl });
  assert.deepEqual(await client.getViewer(), { login: 'octo' });
  const { init } = fetchImpl.calls[0];
  assert.equal(init.headers.Authorization, 'Bearer ghp_x');
  assert.equal(init.headers.Accept, 'application/vnd.github+json');
  assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.match(init.headers['User-Agent'], /github-analytics/);
});

test('getClones returns the parsed traffic payload', async () => {
  const payload = {
    count: 42, uniques: 7,
    clones: [{ timestamp: '2026-09-01T00:00:00Z', count: 5, uniques: 2 }],
  };
  const client = new GitHubClient({
    token: 't', fetchImpl: fakeFetch({ '/repos/octo/hello/traffic/clones': jsonResponse(payload) }),
  });
  const got = await client.getClones('octo/hello');
  assert.equal(got.count, 42);
  assert.equal(got.uniques, 7);
  assert.deepEqual(got.points, payload.clones);
});

test('getViews normalises the payload shape to { count, uniques, points }', async () => {
  const client = new GitHubClient({
    token: 't',
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/views': jsonResponse({
        count: 9, uniques: 3, views: [{ timestamp: '2026-09-01T00:00:00Z', count: 9, uniques: 3 }],
      }),
    }),
  });
  const result = await client.getViews('octo/hello');
  assert.equal(result.count, 9);
  assert.deepEqual(result.points, [{ timestamp: '2026-09-01T00:00:00Z', count: 9, uniques: 3 }]);
});

test('getClones also exposes points', async () => {
  const client = new GitHubClient({
    token: 't',
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/clones': jsonResponse({ count: 1, uniques: 1, clones: [] }),
    }),
  });
  assert.deepEqual((await client.getClones('octo/hello')).points, []);
});

function emptyBodyResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() { return ''; }, // a legitimate 200 with no body -> request() parses this to null
  };
}

test('getClones tolerates a 200 with an empty body instead of throwing', async () => {
  const client = new GitHubClient({
    token: 't', fetchImpl: fakeFetch({ '/repos/octo/hello/traffic/clones': emptyBodyResponse() }),
  });
  const result = await client.getClones('octo/hello');
  assert.deepEqual(result.points, []);
});

test('getViews tolerates a 200 with an empty body instead of throwing', async () => {
  const client = new GitHubClient({
    token: 't', fetchImpl: fakeFetch({ '/repos/octo/hello/traffic/views': emptyBodyResponse() }),
  });
  const result = await client.getViews('octo/hello');
  assert.deepEqual(result.points, []);
});

test('listStargazerDates sends the star+json Accept header', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Accept, 'application/vnd.github.star+json');
    return jsonResponse([{ starred_at: '2026-01-01T00:00:00Z', user: { login: 'octo' } }]);
  };
  const client = new GitHubClient({ token: 'ghp_x', fetchImpl });
  const dates = await client.listStargazerDates('a/b');
  assert.deepEqual(dates, ['2026-01-01T00:00:00Z']);
});

test('request still sends the default Accept when none is given', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
    return jsonResponse({ full_name: 'a/b' });
  };
  await new GitHubClient({ token: 'ghp_x', fetchImpl }).getRepo('a/b');
});

test('listForkDates returns created_at for each fork', async () => {
  const client = new GitHubClient({
    token: 't',
    fetchImpl: fakeFetch({
      '/repos/octo/hello/forks?per_page=100&page=1': jsonResponse([
        { full_name: 'someone/hello', created_at: '2026-02-01T00:00:00Z' },
      ]),
    }),
  });
  const dates = await client.listForkDates('octo/hello');
  assert.deepEqual(dates, ['2026-02-01T00:00:00Z']);
});

test('listOwnedRepos follows pagination until a short page', async () => {
  const page = (n) => Array.from({ length: n }, (_, i) => ({
    full_name: `octo/r${i}`, name: `r${i}`, owner: { login: 'octo' },
    private: false, description: null, html_url: `https://github.com/octo/r${i}`,
    pushed_at: '2026-09-01T00:00:00Z', permissions: { push: true },
  }));
  const client = new GitHubClient({
    token: 't',
    fetchImpl: fakeFetch({
      '/user/repos?affiliation=owner&sort=pushed&per_page=100&page=1': jsonResponse(page(100)),
      '/user/repos?affiliation=owner&sort=pushed&per_page=100&page=2': jsonResponse(page(4)),
    }),
  });
  const repos = await client.listOwnedRepos();
  assert.equal(repos.length, 104);
  assert.equal(repos[0].fullName, 'octo/r0');
  assert.equal(repos[0].canReadTraffic, true);
});

test('a 401 raises an auth GitHubError', async () => {
  const client = new GitHubClient({
    token: 'bad',
    fetchImpl: fakeFetch({ '/user': jsonResponse({ message: 'Bad credentials' }, { status: 401 }) }),
  });
  await assert.rejects(() => client.getViewer(), (err) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 401);
    assert.match(err.message, /Bad credentials/);
    return true;
  });
});

test('a 403 with no rate-limit budget is classified as rate_limit', async () => {
  const client = new GitHubClient({
    token: 't', maxRetries: 0,
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/views': jsonResponse({ message: 'rate limited' }, {
        status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1788568672' },
      }),
    }),
  });
  await assert.rejects(() => client.getViews('octo/hello'), (err) => {
    assert.equal(err.kind, 'rate_limit');
    return true;
  });
});

test('a 403 with budget remaining is a permission problem', async () => {
  const client = new GitHubClient({
    token: 't', maxRetries: 0,
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/views': jsonResponse({ message: 'Must have push access' }, {
        status: 403, headers: { 'x-ratelimit-remaining': '4999' },
      }),
    }),
  });
  await assert.rejects(() => client.getViews('octo/hello'), (err) => {
    assert.equal(err.kind, 'forbidden');
    assert.match(err.message, /push access/);
    return true;
  });
});

test('a 403 with retry-after but no ratelimit header is a rate limit, not a permission error', async () => {
  const client = new GitHubClient({
    token: 't', maxRetries: 0,
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/views': jsonResponse({ message: 'Forbidden' }, {
        status: 403, headers: { 'retry-after': '60' },
      }),
    }),
  });
  await assert.rejects(() => client.getViews('octo/hello'), (err) => {
    assert.equal(err.kind, 'rate_limit');
    return true;
  });
});

test('a 403 naming the secondary rate limit is classified as rate_limit', async () => {
  const client = new GitHubClient({
    token: 't', maxRetries: 0,
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/views': jsonResponse(
        { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        { status: 403 },
      ),
    }),
  });
  await assert.rejects(() => client.getViews('octo/hello'), (err) => {
    assert.equal(err.kind, 'rate_limit');
    return true;
  });
});

test('a plain 403 with rate-limit budget remaining is still a permission error', async () => {
  const client = new GitHubClient({
    token: 't', maxRetries: 0,
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/views': jsonResponse({ message: 'Must have push access to repository' }, {
        status: 403, headers: { 'x-ratelimit-remaining': '4999' },
      }),
    }),
  });
  await assert.rejects(() => client.getViews('octo/hello'), (err) => {
    assert.equal(err.kind, 'forbidden');
    return true;
  });
});

test('a 404 is not_found', async () => {
  const client = new GitHubClient({
    token: 't', maxRetries: 0,
    fetchImpl: fakeFetch({ '/repos/octo/gone': jsonResponse({ message: 'Not Found' }, { status: 404 }) }),
  });
  await assert.rejects(() => client.getRepo('octo/gone'), (err) => err.kind === 'not_found');
});

test('a 5xx is retried and then succeeds', async () => {
  let n = 0;
  const client = new GitHubClient({
    token: 't', maxRetries: 2, sleep: async () => {},
    fetchImpl: fakeFetch({
      '/repos/octo/hello/traffic/popular/referrers': () => {
        n += 1;
        return n === 1
          ? jsonResponse({ message: 'boom' }, { status: 502 })
          : jsonResponse([{ referrer: 'google.com', count: 3, uniques: 2 }]);
      },
    }),
  });
  const referrers = await client.getReferrers('octo/hello');
  assert.equal(n, 2);
  assert.deepEqual(referrers, [{ referrer: 'google.com', count: 3, uniques: 2 }]);
});

test('a network failure is retried and finally raised as kind network', async () => {
  let n = 0;
  const client = new GitHubClient({
    token: 't', maxRetries: 1, sleep: async () => {},
    fetchImpl: async () => { n += 1; throw new TypeError('fetch failed'); },
  });
  await assert.rejects(() => client.getViewer(), (err) => {
    assert.equal(err.kind, 'network');
    return true;
  });
  assert.equal(n, 2, 'initial attempt plus one retry');
});

test('normaliseRepo maps the API shape and marks traffic access', () => {
  assert.deepEqual(normaliseRepo({
    full_name: 'octo/hello', name: 'hello', owner: { login: 'octo' },
    private: true, description: 'hi', html_url: 'https://github.com/octo/hello',
    pushed_at: '2026-09-01T00:00:00Z', permissions: { push: false, pull: true },
  }), {
    fullName: 'octo/hello', owner: 'octo', name: 'hello', private: true,
    description: 'hi', htmlUrl: 'https://github.com/octo/hello',
    pushedAt: '2026-09-01T00:00:00Z', canReadTraffic: false,
    stars: 0, forks: 0, watchers: null,
  });
});

test('normaliseRepo reads the real watcher count, not the stars alias', () => {
  // GitHub's `watchers_count` is a legacy alias for the star count. The actual
  // number of watchers is `subscribers_count`. Reading the wrong one plots
  // stars twice under two different labels.
  const r = normaliseRepo({
    full_name: 'a/b', name: 'b', owner: { login: 'a' },
    stargazers_count: 714, forks_count: 240,
    watchers_count: 714, subscribers_count: 11,
  });
  assert.equal(r.stars, 714);
  assert.equal(r.forks, 240);
  assert.equal(r.watchers, 11);
});

test('normaliseRepo tolerates missing count fields', () => {
  const r = normaliseRepo({ full_name: 'a/b', name: 'b', owner: { login: 'a' } });
  assert.equal(r.stars, 0);
  assert.equal(r.forks, 0);
  assert.equal(r.watchers, null);
});

test('rejects a malformed full name before making a request', async () => {
  const client = new GitHubClient({ token: 't', fetchImpl: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(() => client.getViews('not-a-full-name'), /owner\/repo/);
  await assert.rejects(() => client.getViews('a/b/c'), /owner\/repo/);
});
