// web/app.js
//
// Bootstraps the shell: the topbar (theme toggle, refresh button, status
// pill), the notice area, the recurring status poll, and the hash router.
// View rendering itself lives in views/*.js — this file only decides which
// view is active and feeds it shared state.

import { el, clear, relativeTime, pluralise, noticeKey } from './ui.js';
import { getStatus, triggerPoll } from './api.js';
import { renderHome } from './views/home.js';
import { renderRepo } from './views/repo.js';

// ---------------------------------------------------------------------
// Storage — every access is wrapped, because localStorage/sessionStorage
// can throw (private browsing, disabled storage) and a preference read
// must never be able to take the whole dashboard down.
// ---------------------------------------------------------------------

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage can throw in some private-window modes; losing a preference
    // is fine, crashing the app over it is not.
  }
}

// ---------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------

const state = {
  status: null,
  range: safeGet(localStorage, 'gha-range') || 'all',
  sort: safeGet(localStorage, 'gha-sort') || 'views',
  query: '',
};

// ---------------------------------------------------------------------
// DOM references from the (already final) shell in index.html
// ---------------------------------------------------------------------

const root = document.getElementById('app-root');
const pollStatusEl = document.getElementById('poll-status');
const refreshBtn = document.getElementById('refresh-btn');
const themeBtn = document.getElementById('theme-btn');
const noticesEl = document.getElementById('notices');

// ---------------------------------------------------------------------
// Theme toggle — cycles auto -> light -> dark -> auto. The no-flash inline
// script in index.html already applied any stored explicit choice before
// first paint; this only needs to keep it in sync going forward and label
// the button with the mode that is *currently* active.
// ---------------------------------------------------------------------

const THEME_ORDER = ['auto', 'light', 'dark'];

function getTheme() {
  const stored = safeGet(localStorage, 'gha-theme');
  return THEME_ORDER.includes(stored) ? stored : 'auto';
}

function applyTheme(mode) {
  const html = document.documentElement;
  if (mode === 'auto') {
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', mode);
  }
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  themeBtn.title = `Theme: ${label}`;
  themeBtn.setAttribute('aria-label', `Theme: ${label}. Activate to change.`);
}

function cycleTheme() {
  const current = getTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  safeSet(localStorage, 'gha-theme', next);
  applyTheme(next);
}

themeBtn.addEventListener('click', cycleTheme);
applyTheme(getTheme());

// ---------------------------------------------------------------------
// Notices — dismissible banners in #notices, one per kind. Dismissals are
// remembered in sessionStorage so a banner the user has already read does
// not keep coming back for the rest of the tab's life.
// ---------------------------------------------------------------------

// `#notices` is `aria-live="polite"`, and reconcileNotices runs on every
// status tick (every 2s during a poll). Rebuilding the list unconditionally
// would re-announce unchanged notices to screen readers on that cadence and
// would yank focus out from under a user mid-way to clicking Dismiss. So
// this diffs instead: a notice already on screen is left completely alone
// unless its content (`sig`) has actually changed, in which case only its
// body text is swapped in place — the wrapping node (and its Dismiss
// button) stays put.
const renderedNotices = new Map(); // kind -> { node, bodyEl, sig }

function setNoticeBody(bodyEl, level, children) {
  clear(bodyEl);
  bodyEl.append(
    el('span', { className: 'visually-hidden', text: level === 'error' ? 'Error: ' : 'Warning: ' }),
    ...children,
  );
}

function buildNotice({ kind, level, body }) {
  const notice = el('div', { className: `notice notice--${level}` });
  const icon = el('span', {
    className: 'notice__icon',
    attrs: { 'aria-hidden': 'true' },
    text: level === 'error' ? '⛔' : '⚠',
  });
  const bodyEl = el('div', { className: 'notice__body' });
  setNoticeBody(bodyEl, level, body);
  const close = el('button', {
    className: 'btn btn--icon notice__close',
    type: 'button',
    attrs: { 'aria-label': 'Dismiss' },
    on: {
      click: () => {
        safeSet(sessionStorage, noticeKey(kind), '1');
        notice.remove();
        renderedNotices.delete(kind);
      },
    },
  }, ['×']);
  notice.append(icon, bodyEl, close);
  return { node: notice, bodyEl };
}

function buildNoticeSpecs(status) {
  const specs = [];

  if (status.token.present === false) {
    specs.push({
      kind: 'no_token',
      level: 'warn',
      sig: 'no_token',
      body: [
        'No GitHub token found. Run ',
        el('code', { className: 'mono', text: 'gh auth login' }),
        ' in a terminal, or set ',
        el('code', { className: 'mono', text: 'GITHUB_TOKEN' }),
        ', then restart.',
      ],
    });
  }

  if (status.tokenError) {
    specs.push({
      kind: 'token_error',
      level: 'error',
      sig: `token_error:${status.tokenError}`,
      body: [`GitHub rejected the token: ${status.tokenError}.`],
    });
  }

  if (status.poll?.lastResult?.failed > 0) {
    const failed = status.poll.lastResult.failed;
    specs.push({
      kind: 'poll_failed',
      level: 'warn',
      sig: `poll_failed:${failed}`,
      body: [`${pluralise(failed, 'repository', 'repositories')} failed to update. Open one to see why.`],
    });
  }

  if (status.poll?.lastResult?.aborted === 'rate_limit') {
    specs.push({
      kind: 'rate_limited',
      level: 'warn',
      sig: 'rate_limited',
      body: ["GitHub's rate limit was reached; the run will resume on the next cycle."],
    });
  }

  return specs;
}

function reconcileNotices(status) {
  const specs = buildNoticeSpecs(status);
  const activeKinds = new Set();

  for (const spec of specs) {
    if (safeGet(sessionStorage, noticeKey(spec.kind)) === '1') continue; // dismissed — stays gone
    activeKinds.add(spec.kind);

    const existing = renderedNotices.get(spec.kind);
    if (!existing) {
      const { node, bodyEl } = buildNotice(spec);
      renderedNotices.set(spec.kind, { node, bodyEl, sig: spec.sig });
      noticesEl.append(node);
      continue;
    }
    if (existing.sig !== spec.sig) {
      setNoticeBody(existing.bodyEl, spec.level, spec.body);
      existing.sig = spec.sig;
    }
    // Unchanged: leave the DOM node exactly as it is — no re-announce, no
    // lost focus on its Dismiss button.
  }

  for (const [kind, entry] of renderedNotices) {
    if (!activeKinds.has(kind)) {
      entry.node.remove();
      renderedNotices.delete(kind);
    }
  }
}

// ---------------------------------------------------------------------
// Status poll — a single setTimeout chain, never overlapping intervals:
// 2s while a poll is running, 30s otherwise. Paused while the tab is
// hidden, resumed on visible.
// ---------------------------------------------------------------------

let statusTimer = null;
let prevPollSnapshot = null;

function updatePill(status) {
  pollStatusEl.classList.remove('pill--busy');
  pollStatusEl.style.removeProperty('--progress');

  if (status.poll.seeding) {
    pollStatusEl.textContent = 'Finding repositories…';
    pollStatusEl.classList.add('pill--busy');
    pollStatusEl.style.setProperty('--progress', '100%');
  } else if (status.poll.running) {
    const total = status.poll.total || 0;
    const done = status.poll.done || 0;
    pollStatusEl.textContent = `Polling ${done}/${total}`;
    pollStatusEl.classList.add('pill--busy');
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    pollStatusEl.style.setProperty('--progress', `${pct}%`);
  } else if (!status.token.present) {
    pollStatusEl.textContent = 'No token';
  } else {
    pollStatusEl.textContent = `Updated ${relativeTime(status.poll.lastRunAt)}`;
  }
}

function updatePillOffline() {
  pollStatusEl.classList.remove('pill--busy');
  pollStatusEl.style.removeProperty('--progress');
  pollStatusEl.textContent = 'Offline';
}

// A background status refresh can complete right as the user is typing in
// the search box, or with the manage-repositories panel open; forcing a
// full re-render at that moment would blow the panel away or rip focus out
// from under them. render() destroys and rebuilds the whole active view, so
// we only rerender-on-poll-change when that view reports it isn't busy —
// the view itself (not this file) knows which of its fields count.
function maybeRerenderForPollChange(status) {
  const poll = status.poll;
  const prev = prevPollSnapshot;
  prevPollSnapshot = { running: poll.running, seeding: poll.seeding, done: poll.done, total: poll.total };
  if (!prev) return;

  const changed = prev.running !== poll.running
    || prev.seeding !== poll.seeding
    || ((poll.running || poll.seeding) && prev.done !== poll.done);
  if (!changed) return;

  if (currentView && typeof currentView.isBusy === 'function' && currentView.isBusy()) return;
  render();
}

function scheduleNextStatus(delayMs) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(refreshStatus, delayMs);
}

async function refreshStatus() {
  if (document.hidden) return;
  try {
    const status = await getStatus();
    state.status = status;
    updatePill(status);
    reconcileNotices(status);
    maybeRerenderForPollChange(status);
    scheduleNextStatus(status.poll.running || status.poll.seeding ? 2000 : 30000);
  } catch {
    updatePillOffline();
    scheduleNextStatus(30000);
  }
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  try {
    await triggerPoll();
  } catch {
    // A failure here surfaces on the next status cycle (offline pill /
    // notices); nothing more to do at the click site.
  }
  clearTimeout(statusTimer);
  await refreshStatus();
  refreshBtn.disabled = false;
});

document.addEventListener('visibilitychange', () => {
  clearTimeout(statusTimer);
  if (!document.hidden) refreshStatus();
});

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

const ROUTE_RE = /^#\/repo\/([^/]+)\/([^/]+)$/;

/** `'#/repo/<owner>/<name>'` -> `{ view: 'repo', owner, name }`; anything else -> `{ view: 'home' }`. */
export function parseRoute(hash) {
  const match = ROUTE_RE.exec(hash || '');
  if (!match) return { view: 'home' };
  try {
    return { view: 'repo', owner: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
  } catch {
    return { view: 'home' };
  }
}

/** Navigates to `hash` (adding the leading `#` if missing), re-rendering directly if it is already current. */
export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash === target) {
    render({ moveFocus: true });
  } else {
    window.location.hash = target;
  }
}

const homeCtx = {
  state,
  onRangeChange(range) {
    state.range = range;
    safeSet(localStorage, 'gha-range', range);
  },
  onSortChange(sort) {
    state.sort = sort;
    safeSet(localStorage, 'gha-sort', sort);
  },
  onQueryChange(query) {
    state.query = query;
  },
  refresh() {
    clearTimeout(statusTimer);
    return refreshStatus();
  },
};

let currentView = null;

function render({ moveFocus = false } = {}) {
  const route = parseRoute(window.location.hash);

  if (currentView && typeof currentView.destroy === 'function') currentView.destroy();
  currentView = null;
  clear(root);

  if (route.view === 'repo') {
    currentView = renderRepo(root, {
      owner: route.owner,
      name: route.name,
      state,
      onRangeChange(range) {
        state.range = range;
        safeSet(localStorage, 'gha-range', range);
      },
      navigate,
    });
  } else {
    currentView = renderHome(root, homeCtx);
  }

  if (moveFocus) root.focus();
}

async function init() {
  await refreshStatus();
  await render();
  window.addEventListener('hashchange', () => render({ moveFocus: true }));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
