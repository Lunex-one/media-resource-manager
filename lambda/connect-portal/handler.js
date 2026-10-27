// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

/**
 * The connect portal's API: sign in, list my workstations, start one, connect to one.
 *
 * It is the only thing a user's browser talks to. It authenticates the user itself, keeps the
 * session in a signed HttpOnly cookie, and reaches MRM by invoking MRM's Lambdas directly with a
 * synthetic authorizer context (see mrm-events.js), so MRM's own API and admin console are
 * untouched and the portal can only ever act as the signed-in user, never as an administrator.
 *
 * AWS calls are injected (`deps`) so every route is unit-tested offline.
 */

const {
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  sessionCookie,
  clearedSessionCookie,
  requireCustomHeader,
} = require('./session');
const { mrmEvent } = require('./mrm-events');

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 10 * 1024;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const LOGIN_FAILED =
  'Authentication failed. Check your username and password. If your password has expired, contact an administrator.';

function respond(statusCode, body, extra) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(body),
    ...(extra || {}),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

/** The claims in a JWT, unverified: used only on a token our own ldap-auth Lambda just returned. */
function jwtPayload(token) {
  if (typeof token !== 'string') return {};
  const part = token.split('.')[1];
  if (!part) return {};
  return parseJson(Buffer.from(part, 'base64url').toString('utf8')) || {};
}

/** The few fields the page needs. IP addresses, storage and assignment details stay server-side. */
function projectWorkstation(w) {
  return {
    instanceId: w.instanceId,
    name: w.workstationName || w.instanceId,
    platform: w.platform || '',
    region: w.region || '',
    instanceStatus: w.instanceStatus || '',
    status: w.status || '',
    dcvStatus: w.dcvStatus || '',
  };
}

function isTerminated(w) {
  return String(w.instanceStatus).toLowerCase() === 'terminated' || String(w.status).toLowerCase() === 'terminated';
}

/**
 * The display name DCV shows for a session. create-session requires one. The console sends the
 * person's name, falling back to the part of their email before the @, so the portal does the same;
 * the username is a last resort.
 */
function sessionNameFor(user) {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || String(user.email || '').split('@')[0] || user.username;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function createHandler(deps) {
  const { getSecret, invoke, functions } = deps;
  const clock = deps.now || (() => Date.now());

  async function readBody(event) {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    if (!raw) return {};
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return null;
    const parsed = parseJson(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  }

  function currentUser(event, secret) {
    const cookieHeader = Array.isArray(event.cookies)
      ? event.cookies.join('; ')
      : (event.headers || {}).cookie;
    const claims = verifySessionToken(parseCookies(cookieHeader)[COOKIE_NAME], secret, clock());
    if (!claims || !claims.username) return null;
    return {
      username: claims.username,
      email: claims.email,
      firstName: claims.firstName,
      lastName: claims.lastName,
    };
  }

  async function callMrm(functionName, request, user) {
    const result = await invoke(functionName, mrmEvent(request, user));
    return { status: result.statusCode, data: parseJson(result.body) || {} };
  }

  async function login(body, secret) {
    const { username, password } = body;
    if (
      typeof username !== 'string' || typeof password !== 'string' ||
      !username || !password || username.length > 256 || password.length > 1024
    ) {
      return respond(400, { error: 'Username and password are required.' });
    }
    // The same request ldap-auth accepts on POST /auth/ldap, as change-password sends it.
    const result = await invoke(functions.ldapAuth, {
      httpMethod: 'POST',
      body: JSON.stringify({ username, password }),
    });
    const data = parseJson(result.body) || {};

    if (result.statusCode === 200 && data.success) {
      const profile = jwtPayload(data.token);
      const user = {
        username: data.username || username,
        email: profile.email || '',
        firstName: profile.given_name || '',
        lastName: profile.family_name || '',
      };
      const token = createSessionToken(user, secret, SESSION_TTL_SECONDS, clock());
      console.log(`Signed in ${user.username}`);
      return respond(
        200,
        { username: user.username, name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username },
        { cookies: [sessionCookie(token, SESSION_TTL_SECONDS)] }
      );
    }
    if (result.statusCode === 401) {
      // MRM names a reason only when the directory reported one after verifying the password.
      return respond(401, data.code ? { error: data.error, code: data.code } : { error: LOGIN_FAILED });
    }
    console.error(`ldap-auth answered ${result.statusCode}`);
    return respond(502, { error: 'Sign-in is unavailable. Try again shortly.' });
  }

  async function listWorkstations(user) {
    const { status, data } = await callMrm(functions.workstationManager, { method: 'GET', path: '/workstations' }, user);
    if (status !== 200) {
      console.error(`workstation-manager list answered ${status}`);
      return respond(502, { error: 'Your workstations could not be loaded. Try again shortly.' });
    }
    const list = Array.isArray(data) ? data : data.workstations || data.items || [];
    return respond(200, { workstations: list.filter((w) => !isTerminated(w)).map(projectWorkstation) });
  }

  async function startWorkstation(body, user) {
    if (typeof body.instanceId !== 'string' || !INSTANCE_ID.test(body.instanceId)) {
      return respond(400, { error: 'A valid instanceId is required.' });
    }
    const { status, data } = await callMrm(
      functions.workstationManager,
      { method: 'POST', path: '/workstations/start', body: { instanceId: body.instanceId } },
      user
    );
    if (status === 200) return respond(202, { started: true });
    if (status === 403 || status === 404) {
      return respond(status, { error: data.error || 'You cannot start this workstation.' });
    }
    console.error(`workstation-manager start answered ${status}`);
    return respond(502, { error: 'The workstation could not be started. Try again shortly.' });
  }

  async function connect(body, user) {
    if (typeof body.instanceId !== 'string' || !INSTANCE_ID.test(body.instanceId)) {
      return respond(400, { error: 'A valid instanceId is required.' });
    }
    const { status, data } = await callMrm(
      functions.dcvSessionManager,
      {
        method: 'POST',
        path: '/dcv',
        body: {
          action: 'create-session',
          serverId: body.instanceId,
          sessionName: sessionNameFor(user),
          sessionType: 'console',
        },
      },
      user
    );
    if (status === 200 && isHttpsUrl(data.connectionUrl)) {
      return respond(200, {
        connectionUrl: data.connectionUrl,
        quicConnectionUrl: isHttpsUrl(data.quicConnectionUrl) ? data.quicConnectionUrl : undefined,
      });
    }
    if (status === 403) {
      return respond(403, { error: data.error || 'You may only connect to workstations assigned to you.' });
    }
    // Anything else is most often a machine that is still coming up, so the page retries.
    console.error(`dcv-session-manager answered ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    return respond(503, { error: 'The workstation is not ready yet.', code: 'NOT_READY' });
  }

  return async function handler(event) {
    const method = String(
      (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
      event.httpMethod || 'GET'
    ).toUpperCase();
    const path = event.rawPath || event.path || '/';
    const headers = event.headers || {};

    try {
      if (method === 'POST' && !requireCustomHeader(headers)) {
        return respond(403, { error: 'Forbidden' });
      }
      const secret = await getSecret();

      if (method === 'POST' && path === '/api/login') {
        const body = await readBody(event);
        if (!body) return respond(400, { error: 'Invalid request.' });
        return await login(body, secret);
      }
      if (method === 'POST' && path === '/api/logout') {
        return respond(200, { signedOut: true }, { cookies: [clearedSessionCookie()] });
      }

      const user = currentUser(event, secret);
      if (!user) return respond(401, { error: 'Not signed in.' });

      if (method === 'GET' && path === '/api/me') {
        return respond(200, { username: user.username, email: user.email || '' });
      }
      if (method === 'GET' && path === '/api/workstations') return await listWorkstations(user);
      if (method === 'POST' && (path === '/api/workstations/start' || path === '/api/workstations/connect')) {
        const body = await readBody(event);
        if (!body) return respond(400, { error: 'Invalid request.' });
        return path.endsWith('/start') ? await startWorkstation(body, user) : await connect(body, user);
      }
      return respond(404, { error: 'Not found.' });
    } catch (err) {
      console.error('Portal request failed:', err && err.message);
      return respond(502, { error: 'The service is unavailable. Try again shortly.' });
    }
  };
}

module.exports = { createHandler, projectWorkstation, SESSION_TTL_SECONDS };
