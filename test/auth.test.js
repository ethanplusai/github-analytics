import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuth, parseCookies } from '../src/auth.js';

const PASS = 'correct-horse-battery-staple-9f3a';

test('auth is disabled when no passphrase is configured', () => {
  const auth = createAuth({ passphrase: null });
  assert.equal(auth.enabled, false);
  // A disabled gate must never claim someone is authenticated — callers
  // check `enabled` first, and a true here would be a silent open door.
  assert.equal(auth.isAuthenticated({ headers: {} }), false);
});

test('an empty or whitespace passphrase does not enable auth', () => {
  assert.equal(createAuth({ passphrase: '' }).enabled, false);
  assert.equal(createAuth({ passphrase: '   ' }).enabled, false);
});

test('checkPassphrase accepts the exact value and rejects near misses', () => {
  const auth = createAuth({ passphrase: PASS });
  assert.equal(auth.checkPassphrase(PASS), true);
  assert.equal(auth.checkPassphrase(PASS + 'x'), false);
  assert.equal(auth.checkPassphrase(PASS.slice(0, -1)), false);
  assert.equal(auth.checkPassphrase(''), false);
  assert.equal(auth.checkPassphrase(null), false);
  assert.equal(auth.checkPassphrase(undefined), false);
});

test('a cookie issued now authenticates, and is rejected after it expires', () => {
  let clock = 1_000_000;
  const auth = createAuth({ passphrase: PASS, now: () => clock, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: true });
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req), true);
  clock += 1001;
  assert.equal(auth.isAuthenticated(req), false);
});

test('a tampered signature is rejected', () => {
  const auth = createAuth({ passphrase: PASS });
  const value = /gha_session=([^;]+)/.exec(auth.issueCookie({ secure: true }))[1];
  const [version, exp] = value.split('.');
  const forged = `${version}.${exp}.${'a'.repeat(43)}`;
  assert.equal(auth.isAuthenticated({ headers: { cookie: `gha_session=${forged}` } }), false);
});

test('a cookie with an extended expiry is rejected — the exp is signed', () => {
  const auth = createAuth({ passphrase: PASS, ttlMs: 1000 });
  const value = /gha_session=([^;]+)/.exec(auth.issueCookie({ secure: true }))[1];
  const [version, exp, sig] = value.split('.');
  const forged = `${version}.${Number(exp) + 999999}.${sig}`;
  assert.equal(auth.isAuthenticated({ headers: { cookie: `gha_session=${forged}` } }), false);
});

test('a cookie signed with a different passphrase is rejected', () => {
  const a = createAuth({ passphrase: PASS });
  const b = createAuth({ passphrase: 'a-completely-different-passphrase' });
  const value = /gha_session=([^;]+)/.exec(a.issueCookie({ secure: true }))[1];
  assert.equal(b.isAuthenticated({ headers: { cookie: `gha_session=${value}` } }), false);
});

test('malformed cookies are rejected without throwing', () => {
  const auth = createAuth({ passphrase: PASS });
  for (const cookie of ['', 'gha_session=', 'gha_session=x', 'gha_session=a.b', 'gha_session=a.b.c.d', 'other=1']) {
    assert.equal(auth.isAuthenticated({ headers: { cookie } }), false);
  }
  assert.equal(auth.isAuthenticated({ headers: {} }), false);
});

test('the cookie carries the flags that keep it out of scripts and off http', () => {
  const auth = createAuth({ passphrase: PASS });
  const secure = auth.issueCookie({ secure: true });
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /Secure/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /Path=\//);
  // Locally over http, Secure would make the cookie unusable.
  assert.doesNotMatch(auth.issueCookie({ secure: false }), /Secure/);
});

test('clearCookie expires the session immediately', () => {
  const auth = createAuth({ passphrase: PASS });
  assert.match(auth.clearCookie({ secure: true }), /gha_session=;/);
  assert.match(auth.clearCookie({ secure: true }), /Max-Age=0/);
});

test('parseCookies handles multiple values and spacing', () => {
  // parseCookies returns a null-prototype object (see the dedicated test
  // below), so spread into a plain object before comparing shapes.
  assert.deepEqual({ ...parseCookies('a=1; b=2') }, { a: '1', b: '2' });
  assert.deepEqual({ ...parseCookies('a=1;b=2') }, { a: '1', b: '2' });
  assert.deepEqual({ ...parseCookies('') }, {});
  assert.deepEqual({ ...parseCookies(undefined) }, {});
});

// --- Adversarial tests beyond the brief ---

test('a cookie whose signature is valid but whose version segment is not v1 is rejected', () => {
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  // The signature covers "version.exp", so swapping the version also breaks
  // the signature — this must be rejected on the version check regardless.
  const value = /gha_session=([^;]+)/.exec(auth.issueCookie({ secure: true }))[1];
  const [, exp, sig] = value.split('.');
  const forged = `v2.${exp}.${sig}`;
  assert.equal(auth.isAuthenticated({ headers: { cookie: `gha_session=${forged}` } }), false);
});

test('a cookie value containing .. or an empty middle segment is rejected', () => {
  const auth = createAuth({ passphrase: PASS });
  for (const value of ['v1..sig', 'v1...', '..', 'v1.123.', '.123.sig']) {
    assert.equal(auth.isAuthenticated({ headers: { cookie: `gha_session=${value}` } }), false);
  }
});

test('a very long cookie value is rejected without throwing or hanging', () => {
  const auth = createAuth({ passphrase: PASS });
  const huge = 'v1.' + '9'.repeat(10000) + '.' + 'a'.repeat(10000);
  assert.doesNotThrow(() => {
    assert.equal(auth.isAuthenticated({ headers: { cookie: `gha_session=${huge}` } }), false);
  });
});

test('checkPassphrase rejects a candidate that is a prefix of the real passphrase, and one that has it as a prefix', () => {
  const auth = createAuth({ passphrase: PASS });
  assert.equal(auth.checkPassphrase(PASS.slice(0, 5)), false);
  assert.equal(auth.checkPassphrase(PASS + 'more'), false);
});

test('two createAuth instances built from the same passphrase accept each others cookies', () => {
  // Sessions must survive being routed to a different serverless instance,
  // since each instance is a separate process with its own createAuth call.
  const now = () => 1_000_000;
  const a = createAuth({ passphrase: PASS, now, ttlMs: 60_000 });
  const b = createAuth({ passphrase: PASS, now, ttlMs: 60_000 });
  const value = /gha_session=([^;]+)/.exec(a.issueCookie({ secure: true }))[1];
  const req = { headers: { cookie: `gha_session=${value}` } };
  assert.equal(b.isAuthenticated(req), true);
});

// --- Fix-round 1: mutation-testing findings ---
//
// These tests use an explicit `sessionSecret` override so the test itself
// can forge a validly-SIGNED cookie with a tampered version or exp — that's
// the only way to prove the version/exp checks matter on their own, rather
// than merely riding on a signature failure that would reject the forgery
// for the wrong reason.

const FORGE_SECRET = 'fixed-test-secret-for-forgery';

function forge(secret, payload) {
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

test('a cookie with a VALID signature but an altered version is rejected (I2)', () => {
  const now = () => 1_000_000;
  const auth = createAuth({ passphrase: PASS, sessionSecret: FORGE_SECRET, now, ttlMs: 1000 });
  const exp = now() + 1000;
  const forged = forge(FORGE_SECRET, `v2.${exp}`);
  assert.equal(auth.isAuthenticated({ headers: { cookie: `gha_session=${forged}` } }), false);
});

test('an exp that coerces to Infinity is rejected even with a VALID signature (I2)', () => {
  // "1e999" parses via Number() to Infinity. Without the Number.isFinite
  // guard, `Infinity <= now()` is false, so this would never expire.
  const now = () => 1_000_000;
  const auth = createAuth({ passphrase: PASS, sessionSecret: FORGE_SECRET, now, ttlMs: 1000 });
  const forged = forge(FORGE_SECRET, 'v1.1e999');
  assert.equal(auth.isAuthenticated({ headers: { cookie: `gha_session=${forged}` } }), false);
});

test('checkPassphrase does not throw for a candidate wildly different in length from the passphrase (I2)', () => {
  // This is the functional signature of the digest-first design: hashing
  // both sides to a fixed 32-byte length before timingSafeEqual is what
  // keeps this from ever throwing, regardless of how mismatched the raw
  // input lengths are.
  const auth = createAuth({ passphrase: PASS });
  assert.doesNotThrow(() => {
    assert.equal(auth.checkPassphrase('x'), false);
    assert.equal(auth.checkPassphrase('x'.repeat(10000)), false);
  });
});

test('clearCookie carries HttpOnly, SameSite=Lax and Path=/ so it actually clears a cookie set with those flags (I3)', () => {
  const auth = createAuth({ passphrase: PASS });
  const cleared = auth.clearCookie({ secure: true });
  assert.match(cleared, /HttpOnly/);
  assert.match(cleared, /SameSite=Lax/);
  assert.match(cleared, /Path=\//);
});

test('issueCookie on a disabled instance fails closed with a clear error, not a crash on a null key (I4)', () => {
  const auth = createAuth({ passphrase: null });
  assert.throws(() => auth.issueCookie({ secure: true }), /disabled/);
});

test('parseCookies has no inherited properties, so a lookup for a name never present cannot read an inherited function', () => {
  const result = parseCookies('a=1');
  assert.equal(result.constructor, undefined);
  assert.equal(result.toString, undefined);
  assert.equal(Object.getPrototypeOf(result), null);
});

test('parseCookies keeps the first value when a name repeats (first-wins)', () => {
  assert.deepEqual({ ...parseCookies('a=1; a=2') }, { a: '1' });
});

test('issueCookie uses the __Host- prefix when secure, and isAuthenticated accepts it', () => {
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: true });
  assert.match(setCookie, /^__Host-gha_session=/);
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `__Host-gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req), true);
});

test('issueCookie omits the __Host- prefix when not secure, for plain http', () => {
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: false });
  assert.match(setCookie, /^gha_session=/);
  assert.doesNotMatch(setCookie, /__Host-/);
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req), true);
});

test('a shadowing plain-named cookie does not displace a valid __Host- cookie', () => {
  // This is the secure-deployment scenario: a plain-named cookie riding
  // alongside the real __Host- one must not win, since the __Host- cookie
  // is the one a sibling subdomain (or a plain-http replay) could never
  // have produced legitimately. See isAuthenticated's { secure: true } path.
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: true });
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `gha_session=garbage; __Host-gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req, { secure: true }), true);
});

// --- Fix-round 2: the __Host- fallback was a downgrade path ---
//
// isAuthenticated must know whether the current deployment is secure. If it
// unconditionally falls back to the plain cookie name, a cookie that was
// validly issued (or sniffed) on a plain-http instance — using the same
// passphrase, hence the same signing key — verifies just as well against an
// https instance. That is exactly the replay __Host- exists to stop.

test('with { secure: true }, a validly-signed cookie under the PLAIN name is rejected', () => {
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  // Issue as if from a plain-http instance sharing the same passphrase.
  const setCookie = auth.issueCookie({ secure: false });
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req, { secure: true }), false);
});

test('with { secure: true }, a validly-signed __Host- cookie is accepted', () => {
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: true });
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `__Host-gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req, { secure: true }), true);
});

test('with { secure: false }, a validly-signed plain cookie is accepted (the local path)', () => {
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: false });
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req, { secure: false }), true);
});

test('with { secure: false }, a validly-signed __Host- cookie is still accepted', () => {
  // A developer who ran with secure once should not be locked out locally.
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: true });
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `__Host-gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req, { secure: false }), true);
});

test('calling isAuthenticated(req) with no options behaves as { secure: false }', () => {
  const auth = createAuth({ passphrase: PASS, now: () => 1_000_000, ttlMs: 1000 });
  const setCookie = auth.issueCookie({ secure: false });
  const value = /gha_session=([^;]+)/.exec(setCookie)[1];
  const req = { headers: { cookie: `gha_session=${value}` } };
  assert.equal(auth.isAuthenticated(req), true);
});

test('effectiveLength reflects the trimmed passphrase, not the raw env value', () => {
  assert.equal(createAuth({ passphrase: 'abc' + ' '.repeat(20) }).effectiveLength, 3);
  assert.equal(createAuth({ passphrase: ' '.repeat(20) + 'abc' }).effectiveLength, 3);
  assert.equal(createAuth({ passphrase: '  abc  ' }).effectiveLength, 3);
  assert.equal(createAuth({ passphrase: PASS }).effectiveLength, PASS.length);
  assert.equal(createAuth({ passphrase: '   ' }).effectiveLength, 0);
  assert.equal(createAuth({ passphrase: null }).effectiveLength, 0);
});
