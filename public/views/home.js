// public/views/home.js
//
// The repository overview: hero + stats for the selected range, a controls
// row (range / sort / search), and the repository grid. All view-rendering
// logic lives here — app.js only decides that this view is the active one.

import { el, clear, relativeTime, pluralise, sortRepos, filterRepos } from '../ui.js';
import { getRepos, seedRepos } from '../api.js';
import { renderSparkline, formatCount, formatFullCount } from '../charts.js';
import { renderManagePanel } from './manage.js';

const MANAGE_PANEL_ID = 'manage-repos-panel';

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

// `state.range` ultimately traces back to a URL/localStorage value, so a
// plain-object lookup must never fall through to Object.prototype (a range
// of "toString" resolving to Function.prototype.toString, say).
function rangeHeroLabel(range) {
  return Object.hasOwn(RANGE_HERO_LABEL, range) ? RANGE_HERO_LABEL[range] : 'all time';
}

const SORT_OPTIONS = [
  { value: 'views', label: 'Most views' },
  { value: 'clones', label: 'Most clones' },
  { value: 'polled', label: 'Recently updated' },
  { value: 'name', label: 'Name' },
];

function formatHistorySince(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/** `renderHome(root, ctx) -> { destroy() }` — see task-9-brief.md step 7. */
export function renderHome(root, ctx) {
  const { state, onRangeChange, onSortChange, onQueryChange, refresh } = ctx;

  let destroyed = false;
  let abortController = null;
  let sparkHandles = [];
  let repos = [];
  let hasLoadedOnce = false;
  let queryDebounce = null;
  let query = state.query || '';

  // --- Static shell, built once so focus (esp. the search input) survives
  // every subsequent data refresh. ---------------------------------------

  const section = el('section', { className: 'overview' });
  const heroStats = el('div');
  const historyLine = el('p', { className: 'muted' });
  const footnote = el('p', { className: 'muted' });
  section.append(heroStats, historyLine, footnote);

  const segmented = el('div', { className: 'segmented', attrs: { role: 'group', 'aria-label': 'Date range' } });
  const segButtons = new Map();
  for (const opt of RANGE_OPTIONS) {
    const btn = el('button', {
      type: 'button',
      text: opt.label,
      attrs: { 'aria-pressed': String(opt.value === state.range) },
      on: { click: () => selectRange(opt.value) },
    });
    segButtons.set(opt.value, btn);
    segmented.append(btn);
  }

  const sortSelect = el('select', {
    className: 'field',
    attrs: { 'aria-label': 'Sort repositories' },
    on: { change: (e) => selectSort(e.target.value) },
  });
  for (const opt of SORT_OPTIONS) {
    const optionEl = el('option', { text: opt.label });
    optionEl.value = opt.value;
    if (opt.value === state.sort) optionEl.selected = true;
    sortSelect.append(optionEl);
  }

  const searchInput = el('input', {
    className: 'field',
    id: 'home-search-input',
    type: 'search',
    attrs: { placeholder: 'Filter repositories', 'aria-label': 'Filter repositories' },
    on: {
      input: (e) => {
        const value = e.target.value;
        clearTimeout(queryDebounce);
        queryDebounce = setTimeout(() => selectQuery(value), 150);
      },
    },
  });
  searchInput.value = query;

  const manageBtn = el('button', {
    className: 'btn',
    type: 'button',
    text: 'Manage repositories',
    attrs: { 'aria-expanded': 'false', 'aria-controls': MANAGE_PANEL_ID },
    on: { click: () => toggleManage() },
  });

  const controls = el('div', { className: 'controls' }, [
    segmented,
    sortSelect,
    searchInput,
    el('div', { className: 'controls__spacer' }),
    manageBtn,
  ]);

  // The manage panel mounts in place, directly beneath the controls row —
  // it is not a modal, so opening it never hides this container or the grid
  // below it, and the page keeps scrolling normally.
  const managePanelContainer = el('div', { id: MANAGE_PANEL_ID });
  let managePanel = null;

  const gridArea = el('div');

  section.append(controls, managePanelContainer, gridArea);
  clear(root);
  root.append(section);

  // --- Manage-repositories panel -------------------------------------------

  function closeManage({ returnFocus } = {}) {
    if (!managePanel) return;
    managePanel.destroy();
    managePanel = null;
    clear(managePanelContainer);
    manageBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) manageBtn.focus();
    // While the panel was open we told app.js we were busy, so any poll that
    // finished in that window had its refresh skipped — and the status tick
    // that would have carried it is gone, because the next tick sees no
    // change against the now-settled state. Refetch on close, or the grid
    // silently keeps showing pre-poll numbers with nothing to signal it.
    load();
  }

  function openManage() {
    manageBtn.setAttribute('aria-expanded', 'true');
    managePanel = renderManagePanel(managePanelContainer, {
      onChanged: load,
      onClose: () => closeManage({ returnFocus: true }),
    });
  }

  function toggleManage() {
    if (managePanel) {
      closeManage({ returnFocus: false });
    } else {
      openManage();
    }
  }

  // --- Control handlers ---------------------------------------------------

  function setPressed(value) {
    for (const [v, btn] of segButtons) btn.setAttribute('aria-pressed', String(v === value));
  }

  function selectRange(value) {
    if (value === state.range) return;
    onRangeChange(value);
    setPressed(value);
    load();
  }

  function selectSort(value) {
    onSortChange(value);
    renderGrid();
  }

  function selectQuery(value) {
    query = value;
    onQueryChange(value);
    renderGrid();
  }

  // --- Sparkline lifecycle --------------------------------------------------

  function destroySparks() {
    for (const handle of sparkHandles) handle.destroy();
    sparkHandles = [];
  }

  // --- Hero + stats + honest-labelling copy --------------------------------

  function renderHeroStats(data) {
    clear(heroStats);

    const totals = data.repos.reduce((acc, r) => {
      acc.views += r.range?.views || 0;
      acc.uniqueVisitors += r.range?.uniqueVisitors || 0;
      acc.clones += r.range?.clones || 0;
      acc.uniqueCloners += r.range?.uniqueCloners || 0;
      return acc;
    }, { views: 0, uniqueVisitors: 0, clones: 0, uniqueCloners: 0 });

    const hero = el('div', { className: 'hero' }, [
      el('div', { className: 'hero__value', attrs: { title: formatFullCount(totals.views) }, text: formatCount(totals.views) }),
      el('div', { className: 'hero__label', text: `Views · ${rangeHeroLabel(state.range)}` }),
    ]);

    const stats = el('div', { className: 'stats' });
    for (const [label, value] of [
      ['Unique visitors', totals.uniqueVisitors],
      ['Clones', totals.clones],
      ['Unique cloners', totals.uniqueCloners],
    ]) {
      stats.append(el('div', { className: 'stat' }, [
        el('div', { className: 'stat__label', text: label }),
        el('div', { className: 'stat__value', attrs: { title: formatFullCount(value) }, text: formatCount(value) }),
      ]));
    }

    heroStats.append(hero, stats);

    const repoCount = data.repos.length;
    const firstDays = data.repos.map((r) => r.coverage?.firstDay).filter(Boolean).sort();
    const parts = [`Tracking ${pluralise(repoCount, 'repository', 'repositories')}`];
    if (firstDays.length) parts.push(`history since ${formatHistorySince(firstDays[0])}`);
    parts.push(`updated ${relativeTime(state.status?.poll?.lastRunAt)}`);
    historyLine.textContent = parts.join(' · ');

    footnote.textContent = "Unique counts are GitHub's daily uniques summed over the range — "
      + 'someone who visits on two days counts twice.';
  }

  // --- Empty states ---------------------------------------------------------

  function buildFindingEmpty(pollState) {
    const empty = el('div', { className: 'empty' });
    empty.append(el('p', { className: 'empty__title', text: 'Finding your repositories…' }));

    let bodyText;
    if (pollState.seeding) {
      bodyText = 'Looking for repositories you can access on GitHub…';
    } else {
      const total = pollState.total || 0;
      const done = pollState.done || 0;
      bodyText = total > 0
        ? `Collecting traffic for ${pluralise(total, 'repository', 'repositories')} — ${done} done.`
        : 'Starting…';
    }
    empty.append(el('p', { className: 'empty__body', text: bodyText }));
    return empty;
  }

  function buildNoReposEmpty() {
    const empty = el('div', { className: 'empty' });
    empty.append(el('p', { className: 'empty__title', text: 'No repositories tracked yet' }));
    empty.append(el('p', { className: 'empty__body', text: 'GitHub Analytics can start from the repositories you own.' }));
    const btn = el('button', { className: 'btn btn--primary', type: 'button', text: 'Find my repositories' });
    const errorMsg = el('p', { className: 'empty__body error-text', attrs: { role: 'alert' } });
    errorMsg.hidden = true;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      errorMsg.hidden = true;
      try {
        await seedRepos();
      } catch (err) {
        errorMsg.textContent = err.message || 'Could not start finding repositories. Try again.';
        errorMsg.hidden = false;
      } finally {
        // On success this empty state is about to be replaced entirely once
        // the seeding status lands (see maybeRerenderForPollChange), but on
        // failure nothing else will re-enable it — leaving the button stuck
        // disabled would strand the user on the one screen with nothing
        // else to click.
        btn.disabled = false;
      }
      refresh();
    });
    empty.append(btn, errorMsg);
    return empty;
  }

  function buildNoTokenEmpty() {
    const empty = el('div', { className: 'empty' });
    empty.append(el('p', { className: 'empty__title', text: 'Connect a GitHub token' }));
    empty.append(el('p', { className: 'empty__body' }, [
      'Run ',
      el('code', { className: 'mono', text: 'gh auth login' }),
      ' in a terminal, or set ',
      el('code', { className: 'mono', text: 'GITHUB_TOKEN' }),
      ', then restart.',
    ]));
    return empty;
  }

  function buildNoMatchEmpty(q) {
    const empty = el('div', { className: 'empty' });
    empty.append(el('p', { className: 'empty__body', text: `No repositories match "${q}"` }));
    const btn = el('button', { className: 'btn', type: 'button', text: 'Clear filter' });
    btn.addEventListener('click', () => {
      searchInput.value = '';
      selectQuery('');
    });
    empty.append(btn);
    return empty;
  }

  // --- Repo cards -------------------------------------------------------

  function buildStatBlock(label, value, uniqueValue) {
    return el('div', { className: 'repo-card__stat' }, [
      el('div', {
        className: 'repo-card__stat-value',
        attrs: { title: formatFullCount(value || 0) },
        text: `${label} ${formatCount(value || 0)}`,
      }),
      el('div', { className: 'repo-card__stat-sub', text: `${formatCount(uniqueValue || 0)} unique` }),
    ]);
  }

  function buildRepoCard(repo) {
    const nameLine = el('div', { className: 'repo-card__name mono' }, [
      el('span', { className: 'repo-card__owner', text: `${repo.owner}/` }),
      el('span', { className: 'repo-card__repo', text: repo.name }),
    ]);

    const headRow = el('div', { className: 'repo-card__headrow' }, [nameLine]);
    if (repo.private) headRow.append(el('span', { className: 'badge', text: 'Private' }));

    const desc = el('p', { className: 'repo-card__desc', text: repo.description || '' });

    const sparkContainer = el('div', { className: 'repo-card__spark' });

    const statRow = el('div', { className: 'repo-card__stats' }, [
      buildStatBlock('Views', repo.range?.views, repo.range?.uniqueVisitors),
      buildStatBlock('Clones', repo.range?.clones, repo.range?.uniqueCloners),
    ]);

    const footChildren = [el('span', { text: `Updated ${relativeTime(repo.lastPolledAt)}` })];
    if (repo.lastError) {
      footChildren.push(el('span', {
        className: 'error-text', attrs: { title: repo.lastError }, text: 'Update failed',
      }));
    }
    const foot = el('div', { className: 'repo-card__foot' }, footChildren);

    const card = el('a', {
      className: 'repo-card',
      href: `#/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    }, [headRow, desc, sparkContainer, statRow, foot]);

    sparkHandles.push(renderSparkline(sparkContainer, {
      values: repo.spark?.views || [],
      days: repo.spark?.days || [],
      label: 'Views, last 30 days',
      height: 34,
      slot: 1,
    }));

    return card;
  }

  // --- Grid / empty-state switch ------------------------------------------

  function renderGrid() {
    destroySparks();
    clear(gridArea);

    const pollState = state.status?.poll || {};
    const tokenPresent = state.status?.token?.present !== false;

    if (repos.length === 0) {
      if (pollState.running || pollState.seeding) {
        gridArea.append(buildFindingEmpty(pollState));
      } else if (!tokenPresent) {
        gridArea.append(buildNoTokenEmpty());
      } else {
        gridArea.append(buildNoReposEmpty());
      }
      return;
    }

    const filtered = filterRepos(repos, query);
    const sorted = sortRepos(filtered, state.sort);

    if (sorted.length === 0) {
      gridArea.append(buildNoMatchEmpty(query));
      return;
    }

    const grid = el('div', { className: 'repo-grid' });
    for (const repo of sorted) grid.append(buildRepoCard(repo));
    gridArea.append(grid);
  }

  // --- Data loading --------------------------------------------------------

  function renderLoadError(err) {
    clear(gridArea);
    const empty = el('div', { className: 'empty' });
    empty.append(el('p', { className: 'empty__title', text: "Couldn't load repositories" }));
    empty.append(el('p', { className: 'empty__body error-text', text: err.message || 'Unknown error' }));
    const btn = el('button', { className: 'btn', type: 'button', text: 'Try again' });
    btn.addEventListener('click', load);
    empty.append(btn);
    gridArea.append(empty);
  }

  async function load() {
    if (abortController) abortController.abort();
    const controller = new AbortController();
    abortController = controller;

    if (hasLoadedOnce) section.classList.add('is-loading');

    try {
      const data = await getRepos(state.range, { signal: controller.signal });
      if (destroyed || controller.signal.aborted) return;
      repos = data.repos;
      hasLoadedOnce = true;
      renderHeroStats(data);
      renderGrid();
    } catch (err) {
      if (destroyed || controller.signal.aborted) return;
      renderLoadError(err);
    } finally {
      // A superseded request (30d then 90d before the first reply lands)
      // must not strip the dimming out from under the request that
      // replaced it — only the still-current controller may clear it.
      if (!destroyed && controller === abortController) section.classList.remove('is-loading');
    }
  }

  load();

  return {
    destroy() {
      destroyed = true;
      if (abortController) abortController.abort();
      clearTimeout(queryDebounce);
      destroySparks();
      if (managePanel) managePanel.destroy();
    },
    // A poll-driven status tick must not blow away user input mid-edit: the
    // manage panel (open, or with a field focused) and the header's own
    // search input both count as "busy". app.js consults this instead of
    // hard-coding element ids, so every field this view owns is covered by
    // one mechanism.
    isBusy() {
      if (managePanel) return true;
      const active = document.activeElement;
      if (!active || !section.contains(active)) return false;
      return active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA';
    },
  };
}
