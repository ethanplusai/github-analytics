import { createHmac, timingSafeEqual, createHash, scryptSync } from 'node:crypto';

const COOKIE_NAME = 'gha_session';
// __Host- makes browsers refuse the cookie unless it is Secure, Path=/, and
// carries no Domain attribute — that stops a sibling subdomain from setting
// a cookie that shadows ours. It can't be used on plain http, so it's only
// applied when the caller tells us the connection is secure.
const HOST_PREFIX = '__Host-';
const VERSION = 'v1';
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;

export function parseCookies(header) {
  // No prototype, so a cookie literally named "constructor" or "toString"
  // can't shadow-read as an inherited function for a caller doing a bare
  // property lookup.
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    // First-wins: most cookie parsers do this, and it makes a duplicate,
    // attacker-supplied cookie name harder to use as a shadowing trick.
    if (key in out) continue;
    out[key] = part.slice(index + 1).trim();
  }
  return out;
}

// Comparing digests rather than raw inputs keeps the compared buffers the same
// length whatever the candidate is, so timingSafeEqual never throws and the
// comparison cannot leak the passphrase's length.
function constantTimeEquals(a, b) {
  const da = createHash('sha256').update(String(a)).digest();
  const db = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(da, db);
}

export function createAuth({ passphrase, sessionSecret = null, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const secretSource = typeof passphrase === 'string' ? passphrase.trim() : '';
  const enabled = secretSource.length > 0;

  // A slow KDF, so a captured cookie cannot be turned into an offline
  // passphrase-cracking oracle. Derived once at construction, never per
  // request, so the cost is paid at startup (and once per serverless cold
  // start), not on the hot path. The salt is fixed rather than random
  // because the derivation MUST be deterministic: separate serverless
  // instances have to agree on the key or users get randomly logged out.
  const key = enabled
    ? (sessionSecret || scryptSync(secretSource, 'gha-session-v1', 32).toString('base64url'))
    : null;

  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  return {
    enabled,

    checkPassphrase(candidate) {
      if (!enabled) return false;
      if (typeof candidate !== 'string' || candidate.length === 0) return false;
      return constantTimeEquals(candidate, secretSource);
    },

    issueCookie({ secure }) {
      // Fails closed rather than crashing inside createHmac on a null key —
      // a caller should only ever reach here after enabled/checkPassphrase
      // have already gated access, so this is a programmer-error guard.
      if (!enabled) throw new Error('auth is disabled; cannot issue a session cookie');
      const exp = now() + ttlMs;
      const payload = `${VERSION}.${exp}`;
      const name = secure ? `${HOST_PREFIX}${COOKIE_NAME}` : COOKIE_NAME;
      const parts = [
        `${name}=${payload}.${sign(payload)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(ttlMs / 1000)}`,
      ];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },

    clearCookie({ secure }) {
      // Clear the name matching how it would have been issued, or the
      // browser won't recognize this as the same cookie to delete.
      const name = secure ? `${HOST_PREFIX}${COOKIE_NAME}` : COOKIE_NAME;
      const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },

    isAuthenticated(req) {
      if (!enabled) return false;
      const cookies = parseCookies(req?.headers?.cookie);
      // Prefer the __Host- cookie when present: browsers only ever let a
      // legitimate response set that name over https with Path=/ and no
      // Domain, so it can't have been shadowed by a sibling subdomain. Fall
      // back to the plain name only for local, plain-http deployments.
      const raw = cookies[`${HOST_PREFIX}${COOKIE_NAME}`] ?? cookies[COOKIE_NAME];
      if (!raw) return false;
      const segments = raw.split('.');
      if (segments.length !== 3) return false;
      const [version, exp, signature] = segments;
      if (version !== VERSION) return false;
      const expiry = Number(exp);
      if (!Number.isFinite(expiry) || expiry <= now()) return false;
      const expected = sign(`${version}.${exp}`);
      if (expected.length !== signature.length) return false;
      return constantTimeEquals(signature, expected);
    },
  };
}
