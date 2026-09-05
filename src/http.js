import { createReadStream, promises as fs } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Match a `/segment/:param` style pattern against a pathname.
 * Returns an object of decoded params on match, or null.
 */
export function matchPattern(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];
    if (patternPart.startsWith(':')) {
      try {
        params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      } catch {
        return null;
      }
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

export function readJsonBody(req, { limit = 1_000_000 } = {}) {
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
        // Defer the destroy so the handler's error response (built from the
        // rejection below) has a chance to flush before the socket is torn
        // down; destroying synchronously here would abort the connection
        // before any response bytes reach the client.
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
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        settled = true;
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        settled = true;
        resolvePromise(parsed);
      } catch {
        const err = new Error('Malformed JSON body');
        err.code = 'BAD_JSON';
        fail(err);
      }
    });
  });
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method, pattern, handler });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const params = matchPattern(route.pattern, pathname);
      if (params === null) continue;

      const ctx = { params, query: Object.fromEntries(url.searchParams), url };
      try {
        await route.handler(req, res, ctx);
      } catch {
        if (!res.headersSent) {
          sendError(res, 500, 'internal_error', 'Something went wrong');
        }
      }
      return true;
    }
    return false;
  }

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    handle,
  };
}

export function createStaticHandler({ root, indexFile = 'index.html' }) {
  const rootResolved = resolve(root);

  return async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }

    const relativePath = pathname === '/' ? indexFile : pathname.slice(1);
    const joined = join(rootResolved, relativePath);
    const resolved = resolve(joined);
    if (!(resolved === rootResolved || resolved.startsWith(rootResolved + sep))) {
      return false;
    }

    let targetPath = resolved;
    let stat;
    try {
      stat = await fs.stat(targetPath);
    } catch (err) {
      if (err.code !== 'ENOENT') return false;
      const hasExtension = extname(pathname) !== '';
      const acceptsHtml = (req.headers.accept ?? '').includes('text/html');
      if (hasExtension || !acceptsHtml) return false;

      const fallbackPath = resolve(rootResolved, indexFile);
      try {
        stat = await fs.stat(fallbackPath);
      } catch {
        return false;
      }
      targetPath = fallbackPath;
    }

    const ext = extname(targetPath);
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'cache-control': 'no-cache', etag });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache',
      etag,
    });

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    // The file was stat'd successfully above, but it can still fail to open
    // or fail mid-read (deleted, permissions changed, etc. in the TOCTOU
    // window). serveStatic's contract is Promise<boolean> — a stream error
    // must never become a rejection that escapes to an unhandled promise
    // rejection in a bare `async (req, res) => {...}` call site.
    await new Promise((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      const stream = createReadStream(targetPath);
      stream.on('error', () => {
        if (!res.headersSent) {
          sendError(res, 500, 'internal_error', 'Failed to read file.');
        } else {
          // Headers (and possibly some body bytes) already went out; we
          // cannot change the status now, so give the client a clean
          // connection error instead of letting the socket hang.
          res.destroy();
        }
        finish();
      });
      stream.on('close', finish);
      stream.pipe(res);
    });
    return true;
  };
}

function stripPort(hostHeader) {
  if (!hostHeader) return null;
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end === -1) return hostHeader;
    return hostHeader.slice(0, end + 1);
  }
  const colonIndex = hostHeader.lastIndexOf(':');
  return colonIndex === -1 ? hostHeader : hostHeader.slice(0, colonIndex);
}

function isLoopbackHostname(hostname, extraHosts) {
  if (!hostname) return false;
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const lower = bare.toLowerCase();
  // Hostnames are case-insensitive by spec; compare lower-cased on both
  // sides while keeping this an exact-membership check (never substring).
  return LOOPBACK_HOSTS.has(lower) || extraHosts.some((h) => h.toLowerCase() === lower);
}

export function isRequestLocal(req, { extraHosts = [] } = {}) {
  const hostHeader = req.headers?.host;
  if (!hostHeader) return false;

  const hostname = stripPort(hostHeader);
  if (!isLoopbackHostname(hostname, extraHosts)) return false;

  const method = req.method ?? 'GET';
  const isSafeMethod = method === 'GET' || method === 'HEAD';
  const origin = req.headers?.origin;
  if (!isSafeMethod && origin) {
    let originHostname;
    try {
      originHostname = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (!isLoopbackHostname(originHostname, extraHosts)) return false;
  }

  return true;
}
