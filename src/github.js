export const FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export class GitHubError extends Error {
  constructor(message, { status = 0, path = '', kind = 'unknown', resetAt = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.path = path;
    this.kind = kind;
    this.resetAt = resetAt;
  }
}

export function normaliseRepo(r) {
  return {
    fullName: r.full_name,
    owner: r.owner?.login ?? String(r.full_name || '').split('/')[0],
    name: r.name,
    private: Boolean(r.private),
    description: r.description ?? null,
    htmlUrl: r.html_url ?? null,
    pushedAt: r.pushed_at ?? null,
    canReadTraffic: r.permissions?.push === true,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    // subscribers_count, NOT watchers_count — the latter is a legacy alias for
    // the star count and would silently duplicate it.
    watchers: r.subscribers_count ?? null,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SECONDARY_RATE_LIMIT_RE = /secondary rate limit|abuse detection/i;

function classify(status, headers, message) {
  if (status === 401) return 'auth';
  if (status === 403 || status === 429) {
    const isRateLimit = headers.get('x-ratelimit-remaining') === '0'
      || headers.get('retry-after') !== null
      || SECONDARY_RATE_LIMIT_RE.test(message ?? '');
    if (isRateLimit) return 'rate_limit';
    return status === 403 ? 'forbidden' : 'unknown';
  }
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'unknown';
}

export class GitHubClient {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    baseUrl = 'https://api.github.com',
    sleep = defaultSleep,
    maxRetries = 2,
  } = {}) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
  }

  async request(path, { method = 'GET', accept = 'application/vnd.github+json' } = {}) {
    const url = new URL(path, this.baseUrl);
    const headers = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-analytics',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await this.fetchImpl(url, { method, headers });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new GitHubError(err.message, { path, kind: 'network' });
      }

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }

      if (res.ok) return body;

      const message = body?.message ?? `HTTP ${res.status}`;
      const kind = classify(res.status, res.headers, message);
      let resetAt = null;
      if (kind === 'rate_limit') {
        const resetHeader = res.headers.get('x-ratelimit-reset');
        const retryAfter = res.headers.get('retry-after');
        if (resetHeader !== null) {
          resetAt = Number(resetHeader) || null;
        } else if (retryAfter !== null) {
          resetAt = Math.floor(Date.now() / 1000) + (Number(retryAfter) || 0);
        }
      }

      if ((kind === 'server' || kind === 'rate_limit') && attempt < this.maxRetries) {
        await this.sleep(500 * 2 ** attempt);
        attempt += 1;
        continue;
      }

      throw new GitHubError(message, { status: res.status, path, kind, resetAt });
    }
  }

  assertFullName(fullName) {
    if (!FULL_NAME_RE.test(fullName)) {
      throw new Error('fullName must look like owner/repo');
    }
  }

  async getViewer() {
    return this.request('/user');
  }

  // Walks a paginated collection. The 10-page ceiling is the same guard
  // listOwnedRepos has always had: a bounded loop rather than a trust in the
  // API to eventually return a short page.
  async paginate(path, { accept, maxPages = 10 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await this.request(`${path}${sep}per_page=100&page=${page}`, { accept });
      if (!Array.isArray(items)) break;
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  async listOwnedRepos() {
    const items = await this.paginate('/user/repos?affiliation=owner&sort=pushed');
    return items.map(normaliseRepo);
  }

  async getRepo(fullName) {
    this.assertFullName(fullName);
    return this.request(`/repos/${fullName}`);
  }

  // starred_at is returned ONLY with this Accept header. Without it the call
  // still succeeds and returns a plain user list — the history is silently
  // unrecoverable rather than an error.
  //
  // maxPages is raised well past the default 10 (1,000 items): the fleet's
  // largest repo already has 714 stars, and a 10-page ceiling would silently
  // truncate its history — and any repo that later outgrows even this would
  // do so silently too, so this number is a measured margin, not a promise.
  async listStargazerDates(fullName) {
    this.assertFullName(fullName);
    const rows = await this.paginate(`/repos/${fullName}/stargazers`, {
      accept: 'application/vnd.github.star+json',
      maxPages: 50,
    });
    return rows.map((r) => r.starred_at).filter(Boolean);
  }

  async listForkDates(fullName) {
    this.assertFullName(fullName);
    const rows = await this.paginate(`/repos/${fullName}/forks`, { maxPages: 50 });
    return rows.map((r) => r.created_at).filter(Boolean);
  }

  async getClones(fullName) {
    this.assertFullName(fullName);
    const body = await this.request(`/repos/${fullName}/traffic/clones`);
    // A 200 with an empty body parses to `null` (see request()'s
    // `text ? JSON.parse(text) : null`), and `{ ...null }` already tolerates
    // that — the property reads below did not.
    return { ...body, points: body?.clones ?? [] };
  }

  async getViews(fullName) {
    this.assertFullName(fullName);
    const body = await this.request(`/repos/${fullName}/traffic/views`);
    return { ...body, points: body?.views ?? [] };
  }

  async getReferrers(fullName) {
    this.assertFullName(fullName);
    const body = await this.request(`/repos/${fullName}/traffic/popular/referrers`);
    return Array.isArray(body) ? body : [];
  }

  async getPaths(fullName) {
    this.assertFullName(fullName);
    const body = await this.request(`/repos/${fullName}/traffic/popular/paths`);
    return Array.isArray(body) ? body : [];
  }

  async getRateLimit() {
    return this.request('/rate_limit');
  }
}
