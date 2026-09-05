import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

const COOKIE_NAME = 'gha_session';
const VERSION = 'v1';
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
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

  // Derived from the passphrase by default, so changing the passphrase
  // invalidates every existing session without a second variable to manage.
  const key = enabled
    ? (sessionSecret || createHmac('sha256', secretSource).update('gha-session-v1').digest('base64url'))
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
      const exp = now() + ttlMs;
      const payload = `${VERSION}.${exp}`;
      const parts = [
        `${COOKIE_NAME}=${payload}.${sign(payload)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(ttlMs / 1000)}`,
      ];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },

    clearCookie({ secure }) {
      const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },

    isAuthenticated(req) {
      if (!enabled) return false;
      const raw = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
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
