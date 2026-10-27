// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The connect portal's API, exercised route by route with the AWS calls faked.
 *
 * What these hold: nothing works without a genuine session; every POST needs the custom header;
 * everything asked of MRM is done as the signed-in user and never as an administrator; the page
 * sees only a trimmed view of a workstation; the connection URL must be https; and a failed
 * sign-in says the same thing whether the password was wrong or the account does not exist.
 */

// A module, so its top-level names stay out of the global scope: test files without an
// import or export share one scope across the project and would collide.
export {};

const { createHandler } = require('../lambda/connect-portal/handler.js');
const { COOKIE_NAME, createSessionToken } = require('../lambda/connect-portal/session.js');

const SECRET = 'a-test-secret-that-is-long-enough';
const NOW = 1_800_000_000_000;
const INSTANCE = 'i-0123456789abcdef0';
const CSRF: Record<string, string> = { 'x-requested-with': 'connect-portal' };

type Call = { functionName: string; event: any };

function setup(responses: Record<string, any>) {
  const calls: Call[] = [];
  const handler = createHandler({
    getSecret: async () => SECRET,
    invoke: async (functionName: string, event: any) => {
      calls.push({ functionName, event });
      const response = responses[functionName];
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(event) : response;
    },
    functions: { ldapAuth: 'ldap', workstationManager: 'wm', dcvSessionManager: 'dcv' },
    now: () => NOW,
  });
  return { handler, calls };
}

const lambdaReply = (statusCode: number, body: any) => ({ statusCode, body: JSON.stringify(body) });

function signedIn(claims: Record<string, string> = {}): string[] {
  const token: string = createSessionToken(
    { username: 'richard', email: 'r@x.io', firstName: 'Richard', lastName: 'Duke', ...claims }, SECRET, 3600, NOW);
  return [`${COOKIE_NAME}=${token}`];
}

function request(method: string, path: string, options: { body?: any; cookies?: string[]; headers?: Record<string, string> } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: options.headers || (method === 'POST' ? CSRF : {}),
    cookies: options.cookies,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
}

const ldapToken = (claims: any): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('sign-in', () => {
  const good = lambdaReply(200, {
    success: true,
    username: 'richard',
    token: ldapToken({ email: 'r@x.io', given_name: 'Richard', family_name: 'Duke' }),
  });

  test('sets a session cookie and never echoes the password or the MRM token', async () => {
    const { handler, calls } = setup({ ldap: good });
    const res = await handler(request('POST', '/api/login', { body: { username: 'richard', password: 'pw' } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ username: 'richard', name: 'Richard Duke' });
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0]).toContain('HttpOnly');
    expect(res.body).not.toContain('pw');
    expect(res.body).not.toContain('token');
    expect(JSON.parse(calls[0].event.body)).toEqual({ username: 'richard', password: 'pw' });
  });

  test('says the same generic thing for a wrong password', async () => {
    const { handler } = setup({ ldap: lambdaReply(401, { error: 'Invalid credentials' }) });
    const res = await handler(request('POST', '/api/login', { body: { username: 'x', password: 'bad' } }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toContain('Authentication failed');
    expect(JSON.parse(res.body).code).toBeUndefined();
    expect(res.cookies).toBeUndefined();
  });

  test('relays the reason only when the directory named one', async () => {
    const { handler } = setup({
      ldap: lambdaReply(401, { error: 'Your password has expired. Contact an administrator to reset it.', code: 'PASSWORD_EXPIRED' }),
    });
    const res = await handler(request('POST', '/api/login', { body: { username: 'r', password: 'p' } }));
    expect(JSON.parse(res.body)).toEqual({
      error: 'Your password has expired. Contact an administrator to reset it.',
      code: 'PASSWORD_EXPIRED',
    });
  });

  test('reports an unavailable sign-in when ldap-auth fails', async () => {
    const { handler } = setup({ ldap: lambdaReply(500, { error: 'Internal server error' }) });
    const res = await handler(request('POST', '/api/login', { body: { username: 'r', password: 'p' } }));
    expect(res.statusCode).toBe(502);
  });

  test.each([
    [{}], [{ username: 'r' }], [{ password: 'p' }], [{ username: '', password: 'p' }], [{ username: 5, password: 'p' }],
  ])('rejects the incomplete request %j', async (body: any) => {
    const { handler, calls } = setup({ ldap: good });
    const res = await handler(request('POST', '/api/login', { body }));
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('requires the custom header', async () => {
    const { handler, calls } = setup({ ldap: good });
    const res = await handler(request('POST', '/api/login', { body: { username: 'r', password: 'p' }, headers: {} }));
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('the session', () => {
  test('is required for everything but sign-in and sign-out', async () => {
    const { handler } = setup({});
    for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/workstations'],
      ['POST', '/api/workstations/start'], ['POST', '/api/workstations/connect']]) {
      expect((await handler(request(method, path, { body: {} }))).statusCode).toBe(401);
    }
  });

  test('is rejected when forged or tampered with', async () => {
    const { handler } = setup({});
    const [cookie] = signedIn();
    const tampered: string = cookie.slice(0, -2) + 'xx';
    expect((await handler(request('GET', '/api/me', { cookies: [tampered] }))).statusCode).toBe(401);
    expect((await handler(request('GET', '/api/me', { cookies: [`${COOKIE_NAME}=nonsense`] }))).statusCode).toBe(401);
  });

  test('identifies the signed-in user', async () => {
    const { handler } = setup({});
    const res = await handler(request('GET', '/api/me', { cookies: signedIn() }));
    expect(JSON.parse(res.body)).toEqual({ username: 'richard', email: 'r@x.io' });
  });

  test('sign-out clears the cookie and needs the custom header', async () => {
    const { handler } = setup({});
    const res = await handler(request('POST', '/api/logout', { cookies: signedIn() }));
    expect(res.cookies[0]).toContain('Max-Age=0');
    expect((await handler(request('POST', '/api/logout', { headers: {} }))).statusCode).toBe(403);
  });
});

describe('listing workstations', () => {
  const records = [
    { instanceId: INSTANCE, workstationName: 'Edit 1', platform: 'windows', region: 'us-east-1',
      instanceStatus: 'running', status: 'Complete', dcvStatus: 'ready',
      privateIpAddress: '10.0.1.5', publicIpAddress: '1.2.3.4', assignedUserId: 'richard',
      storageConfig: { x: 1 } },
    { instanceId: 'i-0aaaaaaaaaaaaaaaa', workstationName: 'Old', instanceStatus: 'terminated', status: 'Terminated' },
  ];

  test('shows only live workstations and only the fields the page needs', async () => {
    const { handler } = setup({ wm: lambdaReply(200, { workstations: records }) });
    const res = await handler(request('GET', '/api/workstations', { cookies: signedIn() }));
    const list = JSON.parse(res.body).workstations;
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(
      ['dcvStatus', 'instanceId', 'instanceStatus', 'name', 'platform', 'region', 'status']);
    expect(res.body).not.toContain('10.0.1.5');
    expect(res.body).not.toContain('1.2.3.4');
  });

  test('accepts a bare array from MRM too', async () => {
    const { handler } = setup({ wm: lambdaReply(200, records) });
    const res = await handler(request('GET', '/api/workstations', { cookies: signedIn() }));
    expect(JSON.parse(res.body).workstations).toHaveLength(1);
  });

  test('asks MRM as the user and never as an administrator', async () => {
    const { handler, calls } = setup({ wm: lambdaReply(200, { workstations: [] }) });
    await handler(request('GET', '/api/workstations', { cookies: signedIn() }));
    expect(calls[0].event.httpMethod).toBe('GET');
    expect(calls[0].event.path).toBe('/workstations');
    expect(calls[0].event.requestContext.authorizer.username).toBe('richard');
    expect(calls[0].event.requestContext.authorizer.isAdmin).toBe('false');
  });

  test('reports a failure from MRM without leaking it', async () => {
    const { handler } = setup({ wm: lambdaReply(500, { error: 'dynamo exploded' }) });
    const res = await handler(request('GET', '/api/workstations', { cookies: signedIn() }));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('dynamo');
  });
});

describe('starting a workstation', () => {
  test('starts it as the user', async () => {
    const { handler, calls } = setup({ wm: lambdaReply(200, { message: 'Workstation start initiated' }) });
    const res = await handler(request('POST', '/api/workstations/start', { body: { instanceId: INSTANCE }, cookies: signedIn() }));
    expect(res.statusCode).toBe(202);
    expect(calls[0].event.path).toBe('/workstations/start');
    expect(JSON.parse(calls[0].event.body)).toEqual({ instanceId: INSTANCE });
    expect(calls[0].event.requestContext.authorizer.isAdmin).toBe('false');
  });

  test.each([[''], ['not-an-id'], ['i-xyz'], [5]])('rejects the instance id %j', async (instanceId: any) => {
    const { handler, calls } = setup({});
    const res = await handler(request('POST', '/api/workstations/start', { body: { instanceId }, cookies: signedIn() }));
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('passes MRM\'s refusal for a machine that is not theirs', async () => {
    const { handler } = setup({ wm: lambdaReply(403, { error: 'Access denied. You can only operate workstations assigned to you.' }) });
    const res = await handler(request('POST', '/api/workstations/start', { body: { instanceId: INSTANCE }, cookies: signedIn() }));
    expect(res.statusCode).toBe(403);
  });
});

describe('connecting to a workstation', () => {
  const url = 'https://gw.example.com:8443/?authToken=T#session-1';

  test('returns the connection URLs and asks for a console session as the user', async () => {
    const { handler, calls } = setup({
      dcv: lambdaReply(200, { sessionId: 's', connectionUrl: url, quicConnectionUrl: 'https://gw.example.com:8444/?authToken=T#s', connectionToken: 'T' }),
    });
    const res = await handler(request('POST', '/api/workstations/connect', { body: { instanceId: INSTANCE }, cookies: signedIn() }));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.connectionUrl).toBe(url);
    expect(body.quicConnectionUrl).toContain(':8444');
    expect(body.connectionToken).toBeUndefined();
    expect(JSON.parse(calls[0].event.body)).toEqual({
      action: 'create-session', serverId: INSTANCE, sessionName: 'Richard Duke', sessionType: 'console',
    });
    expect(calls[0].event.requestContext.authorizer.isAdmin).toBe('false');
  });

  test.each([['javascript:alert(1)'], ['http://gw.example.com:8443/'], ['not a url'], [undefined]])(
    'refuses to hand the page the non-https URL %j', async (connectionUrl: any) => {
      const { handler } = setup({ dcv: lambdaReply(200, { connectionUrl }) });
      const res = await handler(request('POST', '/api/workstations/connect', { body: { instanceId: INSTANCE }, cookies: signedIn() }));
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('javascript');
    });

  test('passes a refusal for a machine that is not theirs', async () => {
    const { handler } = setup({ dcv: lambdaReply(403, { error: 'Access denied. You may only connect to workstations assigned to you.' }) });
    const res = await handler(request('POST', '/api/workstations/connect', { body: { instanceId: INSTANCE }, cookies: signedIn() }));
    expect(res.statusCode).toBe(403);
  });

  test('tells the page to retry when the machine is not ready', async () => {
    const { handler } = setup({ dcv: lambdaReply(500, { error: 'No DCV server registered' }) });
    const res = await handler(request('POST', '/api/workstations/connect', { body: { instanceId: INSTANCE }, cookies: signedIn() }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('NOT_READY');
  });

  test('survives MRM being unreachable', async () => {
    const { handler } = setup({ dcv: new Error('timeout') });
    const res = await handler(request('POST', '/api/workstations/connect', { body: { instanceId: INSTANCE }, cookies: signedIn() }));
    expect(res.statusCode).toBe(502);
  });
});

test('unknown routes are 404 once signed in', async () => {
  const { handler } = setup({});
  expect((await handler(request('GET', '/api/nothing', { cookies: signedIn() }))).statusCode).toBe(404);
});

describe('the DCV session name', () => {
  const reply = lambdaReply(200, { connectionUrl: 'https://gw.example.com:8443/?authToken=T#s' });

  async function nameSentFor(claims: Record<string, string>): Promise<string> {
    const { handler, calls } = setup({ dcv: reply });
    await handler(request('POST', '/api/workstations/connect',
      { body: { instanceId: INSTANCE }, cookies: signedIn(claims) }));
    return JSON.parse(calls[0].event.body).sessionName;
  }

  test('is the person\'s full name, as the console sends it', async () => {
    expect(await nameSentFor({})).toBe('Richard Duke');
  });

  test('falls back to the part of the email before the @ when there is no name', async () => {
    expect(await nameSentFor({ firstName: '', lastName: '' })).toBe('r');
  });

  test('falls back to the username when there is neither name nor email', async () => {
    expect(await nameSentFor({ firstName: '', lastName: '', email: '' })).toBe('richard');
  });

  test('is always present, because create-session refuses a request without one', async () => {
    const variants: Record<string, string>[] = [
      {}, { firstName: '' }, { lastName: '' }, { firstName: '', lastName: '', email: '' },
    ];
    for (const claims of variants) {
      expect((await nameSentFor(claims)).length).toBeGreaterThan(0);
    }
  });
});
