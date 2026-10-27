// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The connect portal page. Every piece of text from the server goes in through textContent or a
// text node, never innerHTML, and nothing here needs inline script.

const app = document.getElementById('app');
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const POLL_MS = 5000;
const MAX_POLLS = 90; // about seven and a half minutes
const REFRESH_MS = 15000;

class SessionExpired extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function show(...nodes) {
  app.replaceChildren(...nodes);
}

// CloudFront signs its requests to the Lambda function URL, and a streamed body cannot be signed,
// so every request with a body carries its SHA-256 for CloudFront to include in the signature.
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function api(method, path, body) {
  const payload = method === 'GET' ? undefined : (body ? JSON.stringify(body) : '');
  const headers = { 'X-Requested-With': 'connect-portal' };
  if (body) headers['Content-Type'] = 'application/json';
  if (payload !== undefined) headers['X-Amz-Content-Sha256'] = await sha256Hex(payload);
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: payload || undefined,
  });
  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    // not JSON; leave data empty
  }
  return { ok: response.ok, status: response.status, data };
}

// Like api(), but a 401 means the session is gone.
async function authed(method, path, body) {
  const result = await api(method, path, body);
  if (result.status === 401) throw new SessionExpired();
  return result;
}

async function loadWorkstations() {
  const result = await authed('GET', '/workstations');
  if (!result.ok) throw new Error(result.data.error || 'Your workstations could not be loaded.');
  return result.data.workstations || [];
}

function stateOf(workstation) {
  switch (workstation.instanceStatus) {
    case 'running': return { label: 'Running', kind: 'ok', action: 'Connect' };
    case 'stopped': return { label: 'Stopped', kind: 'idle', action: 'Start and connect' };
    case 'pending': return { label: 'Starting', kind: 'busy', action: 'Connect when ready' };
    case 'stopping': return { label: 'Stopping', kind: 'busy', action: 'Start and connect' };
    default: return { label: workstation.instanceStatus || 'Unknown', kind: 'busy', action: 'Connect when ready' };
  }
}

// Start the machine if it is stopped, wait until it is running and the desktop agent has
// registered, then go into the desktop. `report` shows progress.
async function connectWhenReady(instanceId, report) {
  const first = (await loadWorkstations()).find((w) => w.instanceId === instanceId);
  if (!first) throw new Error('This workstation is not assigned to you.');
  if (first.instanceStatus === 'stopped' || first.instanceStatus === 'stopping') {
    report('Starting your workstation…');
    const started = await authed('POST', '/workstations/start', { instanceId });
    if (!started.ok) throw new Error(started.data.error || 'The workstation could not be started.');
  }
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const current = (await loadWorkstations()).find((w) => w.instanceId === instanceId);
    if (current && current.instanceStatus === 'running') {
      const result = await authed('POST', '/workstations/connect', { instanceId });
      if (result.ok && result.data.connectionUrl) {
        report('Opening your desktop…');
        window.location.assign(result.data.connectionUrl);
        return;
      }
      if (result.status !== 503) throw new Error(result.data.error || 'Could not connect.');
      report('Almost ready…');
    } else {
      report('Starting your workstation…');
    }
    await sleep(POLL_MS);
  }
  throw new Error('The workstation is taking longer than expected. Try again in a few minutes.');
}

function loginView(message) {
  const username = el('input', { id: 'username', name: 'username', type: 'text', autocomplete: 'username', required: true, autofocus: true });
  const password = el('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = el('p', { class: 'error', role: 'alert' }, message || '');
  const button = el('button', { type: 'submit', class: 'primary' }, 'Sign in');
  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      error.textContent = '';
      let result;
      try {
        result = await api('POST', '/login', { username: username.value.trim(), password: password.value });
      } catch (err) {
        result = { ok: false, data: { error: 'The portal is unavailable. Try again shortly.' } };
      }
      if (result.ok) {
        start();
        return;
      }
      password.value = '';
      error.textContent = result.data.error || 'Sign-in failed.';
      button.disabled = false;
    },
  },
  el('h1', {}, 'Connect to your workstation'),
  el('label', { for: 'username' }, 'Username'), username,
  el('label', { for: 'password' }, 'Password'), password,
  button, error);
  show(form);
}

function header(user) {
  return el('div', { class: 'top' },
    el('span', { class: 'muted' }, `Signed in as ${user.username}`),
    el('button', {
      type: 'button',
      onclick: async () => {
        await api('POST', '/logout');
        loginView('');
      },
    }, 'Sign out'));
}

function workstationCard(workstation, controls) {
  const state = stateOf(workstation);
  const progress = el('div', { class: 'progress', role: 'status' });
  const button = el('button', { type: 'button', class: 'primary' }, state.action);
  button.addEventListener('click', async () => {
    controls.lock(true);
    try {
      await connectWhenReady(workstation.instanceId, (text) => { progress.textContent = text; });
    } catch (err) {
      if (err instanceof SessionExpired) {
        loginView('Your session has expired. Sign in again.');
        return;
      }
      progress.textContent = err.message;
      controls.lock(false);
    }
  });
  const link = `${window.location.origin}/connect/${workstation.instanceId}`;
  const linkBox = el('input', { type: 'text', readonly: true, value: link, 'aria-label': `Link for ${workstation.name}` });
  const copy = el('button', {
    type: 'button',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
      } catch (err) {
        linkBox.select();
      }
    },
  }, 'Copy link');
  controls.buttons.push(button);
  return el('section', { class: 'card' },
    el('div', { class: 'row' },
      el('h2', {}, workstation.name),
      el('span', { class: `badge ${state.kind}` }, state.label)),
    el('div', { class: 'muted' }, [workstation.platform, workstation.region].filter(Boolean).join(' · ')),
    el('div', { class: 'actions' }, button),
    progress,
    el('div', { class: 'link' }, linkBox, copy));
}

async function dashboardView(user) {
  let busy = false;
  const controls = {
    buttons: [],
    lock(value) {
      busy = value;
      controls.buttons.forEach((button) => { button.disabled = value; });
    },
  };
  async function draw() {
    const workstations = await loadWorkstations();
    controls.buttons = [];
    const cards = workstations.length
      ? workstations.map((w) => workstationCard(w, controls))
      : [el('p', { class: 'muted' }, 'No workstations are assigned to you yet.')];
    show(header(user), el('h1', {}, 'Your workstations'), ...cards);
  }
  try {
    await draw();
  } catch (err) {
    if (err instanceof SessionExpired) return loginView('Your session has expired. Sign in again.');
    return show(header(user), el('p', { class: 'error' }, err.message));
  }
  const timer = setInterval(async () => {
    if (busy || document.hidden) return;
    try {
      await draw();
    } catch (err) {
      clearInterval(timer);
      if (err instanceof SessionExpired) loginView('Your session has expired. Sign in again.');
    }
  }, REFRESH_MS);
}

async function connectView(user, instanceId) {
  const status = el('p', { class: 'progress', role: 'status' }, 'Preparing your workstation…');
  show(header(user), el('h1', {}, 'Connecting to your workstation'), status);
  try {
    await connectWhenReady(instanceId, (text) => { status.textContent = text; });
  } catch (err) {
    if (err instanceof SessionExpired) return loginView('Your session has expired. Sign in again.');
    show(header(user), el('h1', {}, 'Could not connect'), el('p', { class: 'error' }, err.message),
      el('p', {}, el('a', { href: '/' }, 'Back to my workstations')));
  }
}

async function start() {
  let me;
  try {
    me = await api('GET', '/me');
  } catch (err) {
    return loginView('The portal is unavailable. Try again shortly.');
  }
  if (!me.ok) return loginView(me.status === 401 ? '' : 'The portal is unavailable. Try again shortly.');
  const match = window.location.pathname.match(/^\/connect\/([^/]+)$/);
  if (match && INSTANCE_ID.test(match[1])) return connectView(me.data, match[1]);
  return dashboardView(me.data);
}

start();
