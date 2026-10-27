// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The connect portal's session cookie and the events it sends to MRM.
 *
 * Two properties carry the security of the portal and are worth pinning: a session token cannot be
 * forged, altered or reused after it expires, and everything the portal asks MRM to do is done as
 * a non-administrator, whoever signed in.
 */

// A module, so its top-level names stay out of the global scope: test files without an
// import or export share one scope across the project and would collide.
export {};

const {
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  sessionCookie,
  clearedSessionCookie,
  requireCustomHeader,
} = require('../lambda/connect-portal/session.js');
const { authorizerContext, mrmEvent } = require('../lambda/connect-portal/mrm-events.js');

const SECRET = 'a-test-secret-that-is-long-enough';
const NOW = 1_800_000_000_000;

describe('session token', () => {
  test('round-trips its claims and adds an expiry', () => {
    const token: string = createSessionToken({ username: 'richard' }, SECRET, 3600, NOW);
    const claims = verifySessionToken(token, SECRET, NOW + 1000);
    expect(claims.username).toBe('richard');
    expect(claims.exp).toBe(Math.floor(NOW / 1000) + 3600);
  });

  test('is rejected once it has expired', () => {
    const token: string = createSessionToken({ username: 'richard' }, SECRET, 60, NOW);
    expect(verifySessionToken(token, SECRET, NOW + 59_000)).not.toBeNull();
    expect(verifySessionToken(token, SECRET, NOW + 61_000)).toBeNull();
  });

  test('is rejected when signed with a different secret', () => {
    const token: string = createSessionToken({ username: 'richard' }, SECRET, 3600, NOW);
    expect(verifySessionToken(token, 'another-secret-that-is-long-enough', NOW)).toBeNull();
  });

  test('is rejected when its claims are altered', () => {
    const token: string = createSessionToken({ username: 'richard' }, SECRET, 3600, NOW);
    const [, signature] = token.split('.');
    const forged: string = Buffer.from(
      JSON.stringify({ username: 'someone-else', iat: 1, exp: 9_999_999_999 })
    ).toString('base64url');
    expect(verifySessionToken(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  test.each(['', 'nodots', 'a.b.c', '.', 'a.', '.b'])('rejects the malformed token %j', (token: string) => {
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull();
  });

  test('rejects a missing token without throwing', () => {
    expect(verifySessionToken(undefined, SECRET, NOW)).toBeNull();
    expect(verifySessionToken(null, SECRET, NOW)).toBeNull();
  });

  test('refuses to run with a weak or missing secret', () => {
    expect(() => createSessionToken({}, '', 60, NOW)).toThrow();
    expect(() => createSessionToken({}, 'short', 60, NOW)).toThrow();
    expect(() => verifySessionToken('a.b', undefined, NOW)).toThrow();
  });
});

describe('session cookie', () => {
  test('is Secure, HttpOnly, SameSite=Strict, host-only and path /', () => {
    const cookie: string = sessionCookie('tok', 3600);
    expect(cookie.startsWith(`${COOKIE_NAME}=tok;`)).toBe(true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).not.toContain('Domain');
    expect(COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  test('the clearing cookie expires immediately with the same flags', () => {
    const cookie: string = clearedSessionCookie();
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
  });

  test('is read back out of a Cookie header among others', () => {
    const cookies = parseCookies(`a=1; ${COOKIE_NAME}=tok.en; b=2`);
    expect(cookies[COOKIE_NAME]).toBe('tok.en');
    expect(cookies.a).toBe('1');
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('novalue')).toEqual({});
  });

  test('the first value wins when a cookie name repeats', () => {
    expect(parseCookies('x=first; x=second').x).toBe('first');
  });
});

describe('the CSRF header', () => {
  test('is required with the exact value', () => {
    expect(requireCustomHeader({ 'x-requested-with': 'connect-portal' })).toBe(true);
    expect(requireCustomHeader({ 'x-requested-with': 'XMLHttpRequest' })).toBe(false);
    expect(requireCustomHeader({})).toBe(false);
    expect(requireCustomHeader(undefined)).toBe(false);
  });
});

describe('events sent to MRM', () => {
  const user = { username: 'richard', email: 'r@x.io', firstName: 'Richard', lastName: 'Duke' };

  test('carry the signed-in user and are never administrator, even for an admin session', () => {
    const context = authorizerContext({ ...user, isAdmin: true });
    expect(context.isAdmin).toBe('false');
    expect(context.username).toBe('richard');
    expect(context.userId).toBe('richard');
    expect(context.tokenType).toBe('ldap');
  });

  test('build an API-Gateway-shaped event with a JSON body', () => {
    const event = mrmEvent({ method: 'POST', path: '/dcv', body: { action: 'create-session' } }, user);
    expect(event.httpMethod).toBe('POST');
    expect(event.path).toBe('/dcv');
    expect(JSON.parse(event.body)).toEqual({ action: 'create-session' });
    expect(event.requestContext.authorizer.isAdmin).toBe('false');
  });

  test('send no body when there is none', () => {
    expect(mrmEvent({ method: 'GET', path: '/workstations' }, user).body).toBeNull();
  });
});
