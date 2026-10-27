// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

/**
 * The connect portal's session: a compact HMAC-signed token carried in an HttpOnly cookie, so the
 * page's JavaScript never holds a credential. Pure functions, no I/O.
 *
 * The `__Host-` prefix makes browsers refuse the cookie unless it is Secure, has Path=/ and sets no
 * Domain, so a sibling host cannot plant or overwrite it. SameSite=Strict keeps it off cross-site
 * requests. Together with the required custom header (see requireCustomHeader) that closes CSRF:
 * a cross-site page cannot set that header without a CORS preflight, and this API answers none.
 */

const crypto = require('crypto');

const COOKIE_NAME = '__Host-connect-session';
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'connect-portal';

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('A session secret of at least 16 characters is required');
  }
}

/** A signed token carrying `claims` plus iat/exp. `now` is milliseconds, for tests. */
function createSessionToken(claims, secret, ttlSeconds, now = Date.now()) {
  assertSecret(secret);
  const iat = Math.floor(now / 1000);
  const payload = { ...claims, iat, exp: iat + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** The token's claims when it is genuine and unexpired, otherwise null. Never throws. */
function verifySessionToken(token, secret, now = Date.now()) {
  assertSecret(secret);
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(body, secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  return payload;
}

/** The cookies in a Cookie header as a plain object. */
function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

/**
 * True when the request carries the header only this page's own script sets. State-changing routes
 * require it. Function URL payloads lowercase header names.
 */
function requireCustomHeader(headers) {
  return !!headers && headers[CSRF_HEADER] === CSRF_VALUE;
}

module.exports = {
  COOKIE_NAME,
  CSRF_HEADER,
  CSRF_VALUE,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  sessionCookie,
  clearedSessionCookie,
  requireCustomHeader,
};
