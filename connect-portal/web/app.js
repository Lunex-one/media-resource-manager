// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The connect portal page. Every piece of text from the server goes in through textContent or a
// text node, never innerHTML, and nothing here needs inline script. The state rules live in
// state.js, which loads first and sets globalThis.PortalState.

const app = document.getElementById('app');
const State = globalThis.PortalState;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const POLL_MS = 5000;
const MAX_POLLS = 90; // about seven and a half minutes
const CONNECT_RETRIES = 12;
const FAST_REFRESH_MS = 5000;
const IDLE_REFRESH_MS = 15000;

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

let refreshTimer = null;
function stopRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
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

// ---------------------------------------------------------------- per-workstation notes
// Progress text and a fallback link for each workstation, kept across redraws of the list.

const notes = new Map();
const activeFlows = new Set();

function linkTo(href, label, blank) {
  return /^(https|dcv):/.test(href) ? { href, label, blank: !!blank } : null;
}

function renderNote(instanceId) {
  const target = document.querySelector(`[data-note="${instanceId}"]`);
  if (!target) return;
  const note = notes.get(instanceId) || {};
  const parts = [];
  if (note.text) parts.push(document.createTextNode(note.text));
  if (note.link) {
    parts.push(document.createTextNode(' '));
    parts.push(el('a', {
      href: note.link.href,
      target: note.link.blank ? '_blank' : null,
      rel: 'noopener noreferrer',
    }, note.link.label));
  }
  target.replaceChildren(...parts);
}

function setNote(instanceId, patch) {
  notes.set(instanceId, { ...(notes.get(instanceId) || {}), ...patch });
  renderNote(instanceId);
}

// ---------------------------------------------------------------- the workflows

// Start the machine if it is stopped, then wait until it is truly ready: the instance running and
// its DCV agent registered. The progress shown is MRM's own step name.
async function waitUntilReady(instanceId, report) {
  let started = false;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const workstation = (await loadWorkstations()).find((w) => w.instanceId === instanceId);
    if (!workstation) throw new Error('This workstation is not assigned to you.');
    const state = State.describe(workstation);
    if (state.ready) return workstation;
    if (state.failed) throw new Error('The workstation failed to start. Contact an administrator.');
    if (state.canStart) {
      if (!started) {
        report('Starting your workstation…');
        const result = await authed('POST', '/workstations/start', { instanceId });
        if (!result.ok) throw new Error(result.data.error || 'The workstation could not be started.');
        started = true;
      }
      report('Starting your workstation…');
    } else {
      report(`${state.label}…`);
    }
    await sleep(POLL_MS);
  }
  throw new Error('The workstation is taking longer than expected. Try again in a few minutes.');
}

// Mint a connection and open it: in the window the click opened for the browser, or through the
// dcv:// link the native client registers.
async function openDesktop(instanceId, mode, win) {
  const report = (text) => setNote(instanceId, { text, link: null });
  await waitUntilReady(instanceId, report);
  report('Opening your desktop…');
  let result = null;
  for (let attempt = 0; attempt < CONNECT_RETRIES; attempt += 1) {
    result = await authed('POST', '/workstations/connect', { instanceId });
    if (result.ok && result.data.connectionUrl) break;
    if (result.status !== 503) throw new Error(result.data.error || 'Could not connect.');
    report('Almost ready…');
    await sleep(POLL_MS);
  }
  if (!result || !result.ok || !result.data.connectionUrl) {
    throw new Error('The desktop is not responding yet. Try again in a minute.');
  }

  if (mode === 'client') {
    const dcvUrl = State.toDcvUrl(result.data.quicConnectionUrl || result.data.connectionUrl);
    setNote(instanceId, {
      text: 'Opening your DCV client…',
      link: linkTo(dcvUrl, 'If it did not open, click here'),
    });
    window.location.assign(dcvUrl);
    return;
  }
  const url = result.data.connectionUrl;
  if (win && !win.closed) {
    win.location.href = url;
    setNote(instanceId, { text: 'Your desktop opened in a new window.', link: null });
  } else {
    setNote(instanceId, {
      text: 'Your browser blocked the new window.',
      link: linkTo(url, 'Open your desktop', true),
    });
  }
}

// A browser blocks a window opened after a delay, so the window is opened at the click and sent to
// the desktop when it is ready.
function openBlankWindow() {
  const win = window.open('about:blank', '_blank');
  if (win) {
    try {
      win.opener = null;
      win.document.title = 'Connecting…';
      win.document.body.textContent = 'Preparing your workstation…';
    } catch (err) {
      // a window we cannot write to is still a window we can navigate
    }
  }
  return win;
}

async function runFlow(instanceId, mode, redraw) {
  if (activeFlows.has(instanceId)) return;
  const win = mode === 'browser' ? openBlankWindow() : null;
  activeFlows.add(instanceId);
  redraw();
  setNote(instanceId, { text: 'Preparing…', link: null });
  try {
    await openDesktop(instanceId, mode, win);
  } catch (err) {
    if (win && !win.closed) win.close();
    if (err instanceof SessionExpired) {
      activeFlows.delete(instanceId);
      loginView('Your session has expired. Sign in again.');
      return;
    }
    setNote(instanceId, { text: err.message, link: null });
  }
  activeFlows.delete(instanceId);
  redraw();
}

async function startOnly(instanceId, redraw) {
  if (activeFlows.has(instanceId)) return;
  activeFlows.add(instanceId);
  setNote(instanceId, { text: 'Starting your workstation…', link: null });
  try {
    const result = await authed('POST', '/workstations/start', { instanceId });
    if (!result.ok) throw new Error(result.data.error || 'The workstation could not be started.');
  } catch (err) {
    if (err instanceof SessionExpired) {
      activeFlows.delete(instanceId);
      loginView('Your session has expired. Sign in again.');
      return;
    }
    setNote(instanceId, { text: err.message, link: null });
  }
  activeFlows.delete(instanceId);
  redraw();
}

// ---------------------------------------------------------------- views

function loginView(message) {
  stopRefresh();
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
        stopRefresh();
        await api('POST', '/logout');
        loginView('');
      },
    }, 'Sign out'));
}

function actionButton(label, onClick, primary, disabled) {
  return el('button', {
    type: 'button',
    class: primary ? 'primary' : null,
    disabled: !!disabled,
    onclick: onClick,
  }, label);
}

function workstationCard(workstation, redraw) {
  const state = State.describe(workstation);
  const flowing = activeFlows.has(workstation.instanceId);
  const id = workstation.instanceId;
  const buttons = [];
  if (state.ready) {
    buttons.push(actionButton('Open in browser', () => runFlow(id, 'browser', redraw), true, flowing));
    buttons.push(actionButton('Open in DCV client', () => runFlow(id, 'client', redraw), false, flowing));
  } else if (state.canStart) {
    buttons.push(actionButton('Start', () => startOnly(id, redraw), true, flowing));
  } else if (state.failed) {
    buttons.push(actionButton('Unavailable', () => {}, false, true));
  } else {
    buttons.push(actionButton(`${state.label}…`, () => {}, false, true));
  }
  const link = `${window.location.origin}/connect/${id}`;
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
  return el('section', { class: 'card' },
    el('div', { class: 'row' },
      el('h2', {}, workstation.name),
      el('span', { class: `badge ${state.kind}` }, state.label)),
    el('div', { class: 'muted' }, [workstation.platform, workstation.region].filter(Boolean).join(' · ')),
    el('div', { class: 'actions' }, ...buttons),
    el('div', { class: 'progress', role: 'status', 'data-note': id }),
    el('div', { class: 'link' }, linkBox, copy));
}

async function dashboardView(user) {
  stopRefresh();
  let latest = [];
  function redraw() {
    show(header(user), el('h1', {}, 'Your workstations'),
      ...(latest.length
        ? latest.map((w) => workstationCard(w, refreshNow))
        : [el('p', { class: 'muted' }, 'No workstations are assigned to you yet.')]));
    latest.forEach((w) => renderNote(w.instanceId));
  }
  async function tick() {
    stopRefresh();
    try {
      latest = await loadWorkstations();
      redraw();
      const anyBusy = latest.some((w) => State.describe(w).busy) || activeFlows.size > 0;
      refreshTimer = setTimeout(tick, anyBusy ? FAST_REFRESH_MS : IDLE_REFRESH_MS);
    } catch (err) {
      if (err instanceof SessionExpired) return loginView('Your session has expired. Sign in again.');
      show(header(user), el('p', { class: 'error' }, err.message));
    }
  }
  function refreshNow() {
    stopRefresh();
    refreshTimer = setTimeout(tick, 0);
  }
  await tick();
}

// The stable /connect/<id> link: start the machine if needed, wait, then offer both ways in. It never
// navigates this window away on its own.
async function connectView(user, instanceId) {
  stopRefresh();
  const actions = el('div', { class: 'actions' });
  show(header(user), el('h1', {}, 'Your workstation'),
    el('div', { class: 'progress', role: 'status', 'data-note': instanceId }),
    actions,
    el('p', {}, el('a', { href: '/' }, 'Back to my workstations')));
  setNote(instanceId, { text: 'Preparing your workstation…', link: null });
  try {
    const workstation = await waitUntilReady(instanceId, (text) => setNote(instanceId, { text, link: null }));
    setNote(instanceId, { text: `${workstation.name} is ready.`, link: null });
    const open = (mode) => async () => {
      const win = mode === 'browser' ? openBlankWindow() : null;
      try {
        await openDesktop(instanceId, mode, win);
      } catch (err) {
        if (win && !win.closed) win.close();
        if (err instanceof SessionExpired) return loginView('Your session has expired. Sign in again.');
        setNote(instanceId, { text: err.message, link: null });
      }
    };
    actions.replaceChildren(
      actionButton('Open in browser', open('browser'), true),
      actionButton('Open in DCV client', open('client'), false));
  } catch (err) {
    if (err instanceof SessionExpired) return loginView('Your session has expired. Sign in again.');
    setNote(instanceId, { text: err.message, link: null });
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
