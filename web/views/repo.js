// web/views/repo.js
//
// The repository detail view — the payoff of the whole product. Everything
// else exists so that this page can show a repository's whole history, past
// the 14 days GitHub itself keeps. Structure, top to bottom: header, meta
// line (+ inline error notice), range controls, hero + stats, two
// single-axis time-series charts, referrer/path bar lists, and an honesty
// footnote about the rolling 14-day window. See task-10-brief.md.

import { el, clear, relativeTime, isDeliberateConfirm } from '../ui.js';
import { getRepo, removeRepo, triggerPoll } from '../api.js';
import {
  renderTimeSeries, renderBarList, formatCount, formatFullCount, formatDayLong,
} from '../charts.js';

const RANGE_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'all', label: 'All time' },
];

const RANGE_HERO_LABEL = {
  30: 'last 30 days',
  90: 'last 90 days',
  365: 'last 1 year',
  all: 'all time',
};

// A referrer only ever gets a link when it looks like a bare hostname (no
// scheme, no path) — otherwise GitHub's own referrer strings (e.g. "Google",
// "github.com search") would produce broken or misleading hrefs.
const HOSTNAME_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Strips a full ISO timestamp down to its `YYYY-MM-DD` day, as formatDayLong expects. */
function dayOf(iso) {
  return (iso || '').slice(0, 10);
}

// ---------------------------------------------------------------------
// Header — back link, title, badge, description, and the two right-aligned
// actions (View on GitHub, Stop tracking).
// ---------------------------------------------------------------------

function buildStopTracking(owner, name, navigate, timers) {
  // `.btn` sets `display: inline-flex`, which (being an author rule) beats
  // the UA stylesheet's `[hidden] { display: none }` — so the `hidden` IDL
  // property alone would not actually hide a `.btn`-classed element. Toggle
  // `style.display` explicitly instead.
  const cancelBtn = el('button', { className: 'btn btn--ghost', type: 'button', text: 'Cancel' });
  cancelBtn.style.display = 'none';
  const errorMsg = el('span', { className: 'error-text', attrs: { role: 'alert' } });
  errorMsg.hidden = true;
  const stopBtn = el('button', {
    className: 'btn',
    type: 'button',
    text: 'Stop tracking',
    title: 'History is kept — re-adding this repository restores it.',
  });

  // null when idle; the arming timestamp while armed.
  let armedAt = null;

  function reset() {
    armedAt = null;
    stopBtn.textContent = 'Stop tracking';
    cancelBtn.style.display = 'none';
  }

  stopBtn.addEventListener('click', async () => {
    if (armedAt === null) {
      armedAt = Date.now();
      errorMsg.hidden = true;
      stopBtn.textContent = 'Click again to stop tracking';
      cancelBtn.style.display = '';
      timers.push(setTimeout(reset, 5000));
      return;
    }
    // A double-click, or a held Enter key, delivers both clicks within a few
    // milliseconds — that is one gesture, not two decisions, and it must not
    // untrack the repository.
    if (!isDeliberateConfirm(armedAt, Date.now())) return;
    stopBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await removeRepo(owner, name);
      navigate('#/');
    } catch (err) {
      errorMsg.textContent = err.message || 'Could not stop tracking. Try again.';
      errorMsg.hidden = false;
      stopBtn.disabled = false;
      cancelBtn.disabled = false;
      reset();
    }
  });

  cancelBtn.addEventListener('click', reset);

  return el('div', { className: 'detail__stop' }, [stopBtn, cancelBtn, errorMsg]);
}

function buildHeader(repo, navigate, timers) {
  const header = el('div', { className: 'detail__head' });

  const backLink = el('a', { className: 'detail__back', href: '#/', text: '←  All repositories' });

  const titleRow = el('div', { className: 'detail__title-row' });
  const title = el('h1', { className: 'detail__title mono' }, [
    el('span', { className: 'detail__owner', text: `${repo.owner}/` }),
    el('span', { text: repo.name }),
  ]);
  const titleGroup = el('div', { className: 'detail__title-group' }, [title]);
  if (repo.private) titleGroup.append(el('span', { className: 'badge', text: 'Private' }));

  const actions = el('div', { className: 'detail__actions' }, [
    el('a', {
      className: 'btn',
      href: repo.htmlUrl,
      text: 'View on GitHub ↗',
      attrs: { target: '_blank', rel: 'noopener noreferrer' },
    }),
    buildStopTracking(repo.owner, repo.name, navigate, timers),
  ]);

  titleRow.append(titleGroup, actions);
  header.append(backLink, titleRow);
  if (repo.description) {
    header.append(el('p', { className: 'detail__desc muted', text: repo.description }));
  }
  return header;
}

// ---------------------------------------------------------------------
// Meta line + inline last-error notice.
// ---------------------------------------------------------------------

function buildMeta(repo, coverage, timers) {
  const wrap = el('div', { className: 'detail__meta-wrap' });

  const parts = [
    `Tracking since ${formatDayLong(dayOf(repo.addedAt))}`,
    `${coverage.days} ${coverage.days === 1 ? 'day' : 'days'} of history`,
    `updated ${relativeTime(repo.lastPolledAt)}`,
  ];
  wrap.append(el('p', { className: 'detail__meta muted', text: parts.join(' · ') }));

  if (repo.lastError) {
    const notice = el('div', { className: 'notice notice--error' });
    notice.append(
      el('span', { className: 'notice__icon', attrs: { 'aria-hidden': 'true' }, text: '⛔' }),
      el('div', { className: 'notice__body', text: repo.lastError }),
    );
    const retryBtn = el('button', { className: 'btn btn--xs', type: 'button', text: 'Retry now' });
    retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying…';
      try {
        await triggerPoll();
      } catch {
        // Surfaced by the global status pill/notices on the next poll tick.
      }
      timers.push(setTimeout(() => {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry now';
      }, 1500));
    });
    notice.append(retryBtn);
    wrap.append(notice);
  }

  return wrap;
}

// ---------------------------------------------------------------------
// Controls — the same segmented range control as the overview, scoping the
// hero, stats, and both charts/panel sections below it.
// ---------------------------------------------------------------------

function buildControls(range, onSelect) {
  const segmented = el('div', { className: 'segmented', attrs: { role: 'group', 'aria-label': 'Date range' } });
  for (const opt of RANGE_OPTIONS) {
    segmented.append(el('button', {
      type: 'button',
      text: opt.label,
      attrs: { 'aria-pressed': String(opt.value === range) },
      on: { click: () => onSelect(opt.value) },
    }));
  }
  return el('div', { className: 'controls' }, [segmented]);
}

// ---------------------------------------------------------------------
// Hero + stats — exactly one hero figure (total views in range).
// ---------------------------------------------------------------------

function buildStat(label, value) {
  return el('div', { className: 'stat' }, [
    el('div', { className: 'stat__label', text: label }),
    el('div', { className: 'stat__value', attrs: { title: formatFullCount(value) }, text: formatCount(value) }),
  ]);
}

function buildHeroStats(data) {
  const wrap = el('div');

  const hero = el('div', { className: 'hero' }, [
    el('div', {
      className: 'hero__value',
      attrs: { title: formatFullCount(data.totals.views) },
      text: formatCount(data.totals.views),
    }),
    el('div', { className: 'hero__label', text: `Views · ${RANGE_HERO_LABEL[data.range] || 'all time'}` }),
  ]);

  const stats = el('div', { className: 'stats' }, [
    buildStat('Unique visitors', data.totals.uniqueVisitors),
    buildStat('Clones', data.totals.clones),
    buildStat('Unique cloners', data.totals.uniqueCloners),
  ]);

  if (data.latestWindow) {
    const lw = data.latestWindow;
    const tile = el('div', { className: 'stat' }, [
      el('div', { className: 'stat__label', text: 'Last 14 days (GitHub)' }),
      el('div', {
        className: 'stat__value',
        attrs: { title: formatFullCount(lw.views.uniques) },
        text: `${formatCount(lw.views.uniques)} unique visitors`,
      }),
      el('div', {
        className: 'stat__sub',
        attrs: { title: formatFullCount(lw.views.count) },
        text: `${formatCount(lw.views.count)} views`,
      }),
    ]);
    stats.append(tile);
  }

  const footnote = el('p', { className: 'muted' }, [
    "Unique counts are GitHub's daily uniques summed over the range — "
    + 'someone who visits on two days counts twice.',
  ]);

  wrap.append(hero, stats, footnote);
  return wrap;
}

// ---------------------------------------------------------------------
// Charts — two single-axis time series, stacked. Never combined: clones and
// views differ by an order of magnitude, and dataviz forbids dual-axis
// plots.
// ---------------------------------------------------------------------

const CHART_EMPTY_MESSAGE = 'No traffic recorded yet. The first poll runs within a few minutes of adding a repository.';

function buildCharts(data, chartHandles) {
  const stack = el('div', { className: 'chart-stack' });
  const viewsContainer = el('div');
  const clonesContainer = el('div');
  stack.append(viewsContainer, clonesContainer);

  chartHandles.push(renderTimeSeries(viewsContainer, {
    title: 'Views',
    subtitle: 'Daily views and unique visitors',
    days: data.series.days,
    series: [
      { key: 'views', label: 'Views', values: data.series.views, slot: 1 },
      { key: 'uniqueVisitors', label: 'Unique visitors', values: data.series.uniqueVisitors, slot: 2 },
    ],
    emptyMessage: CHART_EMPTY_MESSAGE,
  }));

  chartHandles.push(renderTimeSeries(clonesContainer, {
    title: 'Clones',
    subtitle: 'Daily clones and unique cloners',
    days: data.series.days,
    series: [
      { key: 'clones', label: 'Clones', values: data.series.clones, slot: 1 },
      { key: 'uniqueCloners', label: 'Unique cloners', values: data.series.uniqueCloners, slot: 2 },
    ],
    emptyMessage: CHART_EMPTY_MESSAGE,
  }));

  return stack;
}

// ---------------------------------------------------------------------
// Panels — top referrers / top paths, GitHub's rolling 14-day window.
// ---------------------------------------------------------------------

const PANEL_EMPTY_MESSAGE = "Nothing recorded in GitHub's current window.";

function buildPanels(data, chartHandles) {
  const grid = el('div', { className: 'panel-grid' });
  const referrersContainer = el('div');
  const pathsContainer = el('div');
  grid.append(referrersContainer, pathsContainer);

  const referrerItems = data.referrers.items.map((it) => ({
    label: it.referrer,
    sublabel: `${formatFullCount(it.uniques)} unique`,
    href: HOSTNAME_RE.test(it.referrer) ? `https://${it.referrer}` : null,
    count: it.count,
    uniques: it.uniques,
    peakCount: it.peakCount,
    firstSeen: it.firstSeen,
  }));

  chartHandles.push(renderBarList(referrersContainer, {
    title: 'Top referrers',
    subtitle: data.referrers.day
      ? `GitHub's rolling 14-day window, as of ${formatDayLong(data.referrers.day)}`
      : "GitHub's rolling 14-day window",
    items: referrerItems,
    emptyMessage: PANEL_EMPTY_MESSAGE,
    valueLabel: 'Views',
  }));

  const pathItems = data.paths.items.map((it) => ({
    label: it.path,
    sublabel: it.title,
    href: `https://github.com${it.path}`,
    count: it.count,
    uniques: it.uniques,
    peakCount: it.peakCount,
    firstSeen: it.firstSeen,
  }));

  chartHandles.push(renderBarList(pathsContainer, {
    title: 'Top paths',
    subtitle: data.paths.day
      ? `GitHub's rolling 14-day window, as of ${formatDayLong(data.paths.day)}`
      : "GitHub's rolling 14-day window",
    items: pathItems,
    emptyMessage: PANEL_EMPTY_MESSAGE,
    valueLabel: 'Views',
  }));

  return grid;
}

function buildFootnote() {
  return el('p', { className: 'detail__footnote muted' }, [
    'Referrers and paths are a rolling 14-day total from GitHub, so they are shown as a current '
    + 'snapshot with the highest value ever recorded. Daily clone and view counts are kept forever.',
  ]);
}

// ---------------------------------------------------------------------
// Empty / error states.
// ---------------------------------------------------------------------

function buildNotFound(navigate) {
  const empty = el('div', { className: 'empty' });
  empty.append(el('p', { className: 'empty__title', text: "That repository isn't tracked" }));
  const btn = el('button', { className: 'btn btn--primary', type: 'button', text: 'Back to all repositories' });
  btn.addEventListener('click', () => navigate('#/'));
  empty.append(btn);
  return empty;
}

function buildLoadError(err, onRetry) {
  const empty = el('div', { className: 'empty' });
  empty.append(el('p', { className: 'empty__title', text: "Couldn't load this repository" }));
  empty.append(el('p', { className: 'empty__body error-text', text: err.message || 'Unknown error' }));
  const btn = el('button', { className: 'btn', type: 'button', text: 'Try again' });
  btn.addEventListener('click', onRetry);
  empty.append(btn);
  return empty;
}

// ---------------------------------------------------------------------
// renderRepo(root, ctx) -> { destroy() }
// ctx = { owner, name, state, onRangeChange, navigate }
// ---------------------------------------------------------------------

export function renderRepo(root, ctx) {
  const { owner, name, state, onRangeChange, navigate } = ctx;

  let destroyed = false;
  let chartHandles = [];
  let timers = [];
  let hasLoadedOnce = false;
  let generation = 0;
  let rangeHadFocus = false;

  const section = el('section', { className: 'detail' });
  clear(root);
  root.append(section);

  function destroyCharts() {
    for (const handle of chartHandles) handle.destroy();
    chartHandles = [];
  }

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  function selectRange(value) {
    if (value === state.range) return;
    rangeHadFocus = section.contains(document.activeElement);
    onRangeChange(value);
    load();
  }

  function renderLoaded(data) {
    destroyCharts();
    clearTimers();
    clear(section);
    section.append(
      buildHeader(data.repo, navigate, timers),
      buildMeta(data.repo, data.coverage, timers),
      buildControls(data.range, selectRange),
      buildHeroStats(data),
      buildCharts(data, chartHandles),
      buildPanels(data, chartHandles),
      buildFootnote(),
    );
    restoreRangeFocus();
  }

  // renderLoaded rebuilds the controls row, so the range button the user just
  // activated is a different element afterwards. Without this a keyboard user
  // loses focus to <body> on every range change.
  function restoreRangeFocus() {
    if (!rangeHadFocus) return;
    rangeHadFocus = false;
    const active = section.querySelector('.segmented button[aria-pressed="true"]');
    if (active) active.focus();
  }

  function renderFailed(err) {
    destroyCharts();
    clearTimers();
    clear(section);
    if (err.status === 404 || err.code === 'not_found') {
      section.append(buildNotFound(navigate));
    } else {
      section.append(buildLoadError(err, load));
    }
  }

  async function load() {
    // Each request carries a generation. Clicking 30d then 90d before the
    // first response lands must not let the slower 30d response paint over
    // the 90d view — the page would then show one range's numbers under
    // another range's label, with nothing to signal it.
    generation += 1;
    const mine = generation;
    if (hasLoadedOnce) section.classList.add('is-loading');
    try {
      const data = await getRepo(owner, name, state.range);
      if (destroyed || mine !== generation) return;
      hasLoadedOnce = true;
      renderLoaded(data);
    } catch (err) {
      if (destroyed || mine !== generation) return;
      hasLoadedOnce = true;
      renderFailed(err);
    } finally {
      if (!destroyed && mine === generation) section.classList.remove('is-loading');
    }
  }

  load();

  return {
    destroy() {
      destroyed = true;
      destroyCharts();
      clearTimers();
    },
  };
}
