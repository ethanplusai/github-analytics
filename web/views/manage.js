// web/views/manage.js
//
// The inline repository-management panel — the UI half of "pick and choose
// which of your repos to track". Not a modal: it renders into a container
// `home.js` mounts directly beneath the controls row, the page behind it
// keeps scrolling, and there is no backdrop, scroll lock, or focus trap.
// Escape and the Close button both just ask `ctx.onClose()` to collapse it.
//
// The panel opens already populated from `/api/available-repos` — nothing
// has to be typed to proceed. The `owner/repo` field at the bottom is a
// secondary path for a repo that list does not cover (an organisation repo
// the user has push access to but does not own). See task-11-brief.md.

import { el, clear, relativeTime, filterRepos, isDeliberateConfirm } from '../ui.js';
import { getAvailableRepos, addRepo, removeRepo } from '../api.js';

const ADD_ERROR_COPY = {
  invalid_repo: 'Enter a repository as owner/repo.',
  no_traffic_access: 'You need push access to that repository to read its traffic.',
  not_found: 'No such repository, or your token cannot see it.',
};

// Shared by both the add-by-name form and each row's Track button (see
// buildTrackControl below) — same action, one vocabulary, and a defensive
// hasOwn guard since `err.code` traces back to the server's response.
function addErrorMessage(err) {
  if (err.code && Object.hasOwn(ADD_ERROR_COPY, err.code)) return ADD_ERROR_COPY[err.code];
  return err.message || 'Could not add that repository.';
}

// ---------------------------------------------------------------------
// Header — title + Close. Close (and Escape, wired below) both just call
// `onClose`; closing the panel and returning focus to the trigger is the
// caller's job, since the trigger button lives in home.js, not here.
// ---------------------------------------------------------------------

function buildHeader(onClose) {
  const closeBtn = el('button', {
    className: 'btn btn--ghost',
    type: 'button',
    text: 'Close',
    on: { click: onClose },
  });
  return el('div', { className: 'panel__head' }, [
    el('div', { className: 'panel__title', text: 'Manage repositories' }),
    el('div', { className: 'controls__spacer' }),
    closeBtn,
  ]);
}

// ---------------------------------------------------------------------
// No-token fallback — the panel still opens and still closes; it just has
// nothing to list without a token to ask GitHub with.
// ---------------------------------------------------------------------

function buildNoToken() {
  return el('p', { className: 'muted' }, [
    'Managing repositories needs a GitHub token. Run ',
    el('code', { className: 'mono', text: 'gh auth login' }),
    ' in a terminal, or set ',
    el('code', { className: 'mono', text: 'GITHUB_TOKEN' }),
    ', then restart.',
  ]);
}

function buildLoadError(err, onRetry) {
  const wrap = el('div');
  wrap.append(el('p', { className: 'error-text', text: err.message || "Couldn't load your repositories." }));
  const btn = el('button', { className: 'btn', type: 'button', text: 'Try again' });
  btn.addEventListener('click', onRetry);
  wrap.append(btn);
  return wrap;
}

// ---------------------------------------------------------------------
// Rows — one per available repo. Track and Untrack are each a
// self-contained control: the button/inline-error pairing owns its own
// pending/error state, and only a *successful* action mutates the shared
// `repo` object and triggers a full list re-render (so tracked-first
// ordering stays correct).
// ---------------------------------------------------------------------

function buildTrackControl(repo, errorEl, onSettled) {
  const btn = el('button', { className: 'btn btn--primary', type: 'button', text: 'Track' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    errorEl.hidden = true;
    try {
      await addRepo(repo.fullName);
      repo.tracked = true;
      onSettled();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Track';
      errorEl.textContent = addErrorMessage(err);
      errorEl.hidden = false;
    }
  });
  return el('div', { className: 'panel__row-actions' }, [btn]);
}

function buildUntrackControl(repo, errorEl, onSettled, timers) {
  // Mirrors the two-click inline confirm in views/repo.js's "Stop tracking"
  // control, so the two pages behave identically.
  const cancelBtn = el('button', { className: 'btn btn--ghost btn--xs', type: 'button', text: 'Cancel' });
  cancelBtn.style.display = 'none';
  const btn = el('button', {
    className: 'btn',
    type: 'button',
    text: 'Untrack',
    title: 'History is kept — re-adding this repository restores it.',
  });

  // null when idle; the arming timestamp while armed.
  let armedAt = null;

  function reset() {
    armedAt = null;
    btn.textContent = 'Untrack';
    cancelBtn.style.display = 'none';
  }

  btn.addEventListener('click', async () => {
    if (armedAt === null) {
      armedAt = Date.now();
      errorEl.hidden = true;
      btn.textContent = 'Click again to untrack';
      cancelBtn.style.display = '';
      timers.push(setTimeout(reset, 5000));
      return;
    }
    // A double-click, or a held Enter key, delivers both clicks within a few
    // milliseconds — that is one gesture, not two decisions.
    if (!isDeliberateConfirm(armedAt, Date.now())) return;
    btn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await removeRepo(repo.owner, repo.name);
      repo.tracked = false;
      onSettled();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not stop tracking. Try again.';
      errorEl.hidden = false;
      btn.disabled = false;
      cancelBtn.disabled = false;
      reset();
    }
  });

  cancelBtn.addEventListener('click', reset);

  return el('div', { className: 'panel__row-actions' }, [btn, cancelBtn]);
}

function buildRow(repo, onSettled, timers) {
  const errorEl = el('span', { className: 'error-text panel__row-error' });
  errorEl.hidden = true;

  const titleRow = el('div', { className: 'panel__row-title' }, [
    el('span', { className: 'mono', text: repo.fullName }),
  ]);
  if (repo.private) titleRow.append(el('span', { className: 'badge', text: 'Private' }));

  const info = el('div', { className: 'panel__row-info' }, [titleRow]);
  if (repo.description) {
    info.append(el('div', { className: 'panel__desc', title: repo.description, text: repo.description }));
  }
  info.append(el('div', { className: 'panel__row-meta muted', text: `Pushed ${relativeTime(repo.pushedAt)}` }));

  const actions = repo.tracked
    ? buildUntrackControl(repo, errorEl, onSettled, timers)
    : buildTrackControl(repo, errorEl, onSettled);

  return el('div', { className: 'panel__row' }, [info, actions, errorEl]);
}

// ---------------------------------------------------------------------
// Add-by-name form — the secondary, typing-required path. Errors get the
// exact copy the brief specifies per API error code, shown beside the field.
// ---------------------------------------------------------------------

function buildAddForm(onAdded) {
  const input = el('input', {
    className: 'field',
    id: 'manage-add-input',
    attrs: { placeholder: 'owner/repo', 'aria-label': 'Add a repository by owner/repo' },
  });
  const errorEl = el('span', { className: 'error-text' });
  errorEl.hidden = true;
  const submitBtn = el('button', { className: 'btn btn--primary', type: 'submit', text: 'Add' });

  const form = el('form', { className: 'panel__add' }, [
    el('label', { className: 'visually-hidden', attrs: { for: 'manage-add-input' }, text: 'Repository (owner/repo)' }),
    input,
    submitBtn,
    errorEl,
  ]);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = input.value.trim();
    if (!fullName) {
      input.focus();
      return;
    }
    input.disabled = true;
    submitBtn.disabled = true;
    errorEl.hidden = true;
    try {
      await addRepo(fullName);
      input.value = '';
      onAdded();
    } catch (err) {
      errorEl.textContent = addErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      input.disabled = false;
      submitBtn.disabled = false;
    }
  });

  return form;
}

// ---------------------------------------------------------------------
// renderManagePanel(container, ctx) -> { destroy() }
// ctx = { onChanged, onClose }
// ---------------------------------------------------------------------

export function renderManagePanel(container, ctx) {
  const { onChanged, onClose } = ctx;

  let destroyed = false;
  let repos = [];
  let query = '';
  let rowTimers = [];

  // Filled in once the initial load succeeds (see renderLoaded()).
  let filterInputEl = null;
  let countsEl = null;
  let listEl = null;

  const section = el('section', {
    className: 'panel',
    attrs: { 'aria-label': 'Manage tracked repositories', tabindex: '-1' },
  });
  const body = el('div', { className: 'panel__body' });
  section.append(buildHeader(onClose), body);

  clear(container);
  container.append(section);

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
  section.addEventListener('keydown', onKeydown);

  function clearRowTimers() {
    for (const t of rowTimers) clearTimeout(t);
    rowTimers = [];
  }

  function updateCounts() {
    const trackedCount = repos.filter((r) => r.tracked).length;
    const availableCount = repos.length - trackedCount;
    countsEl.textContent = `${trackedCount} tracked · ${availableCount} available`;
  }

  function sortAvailable(list) {
    return [...list].sort((a, b) => {
      if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
      return new Date(b.pushedAt || 0).getTime() - new Date(a.pushedAt || 0).getTime();
    });
  }

  function renderRows() {
    clearRowTimers();
    clear(listEl);
    const filtered = filterRepos(repos, query);
    const sorted = sortAvailable(filtered);
    if (sorted.length === 0) {
      listEl.append(el('p', {
        className: 'muted',
        text: query ? `No repositories match "${query}"` : 'No repositories found.',
      }));
    } else {
      for (const repo of sorted) {
        listEl.append(buildRow(repo, () => { onChanged(); renderRows(); }, rowTimers));
      }
    }
    updateCounts();
  }

  // A successful add through the free-text field might name a repo this
  // list never had (e.g. an org repo — see the module comment), so instead
  // of guessing its shape from the POST response, just re-ask the server
  // for the authoritative list.
  async function reloadAvailable() {
    try {
      const data = await getAvailableRepos();
      if (destroyed) return;
      repos = data.repos;
      renderRows();
    } catch {
      // The add itself already succeeded (onChanged() already ran); leaving
      // the current, slightly-stale list up beats replacing it with an error.
    }
  }

  function renderLoaded() {
    clear(body);
    filterInputEl = el('input', {
      className: 'field',
      type: 'search',
      attrs: { placeholder: 'Filter repositories', 'aria-label': 'Filter repositories' },
      on: {
        input: (e) => {
          query = e.target.value;
          renderRows();
        },
      },
    });
    countsEl = el('p', { className: 'muted panel__counts' });
    listEl = el('div', { className: 'panel__list' });
    const addForm = buildAddForm(() => { onChanged(); reloadAvailable(); });

    body.append(filterInputEl, countsEl, listEl, addForm);
    renderRows();
    filterInputEl.focus();
  }

  function renderNoToken() {
    clear(body);
    body.append(buildNoToken());
    section.focus();
  }

  function renderFailed(err) {
    clear(body);
    body.append(buildLoadError(err, load));
    section.focus();
  }

  async function load() {
    clear(body);
    body.append(el('p', { className: 'muted', text: 'Loading your repositories…' }));
    try {
      const data = await getAvailableRepos();
      if (destroyed) return;
      repos = data.repos;
      renderLoaded();
    } catch (err) {
      if (destroyed) return;
      if (err.code === 'no_token') {
        renderNoToken();
      } else {
        renderFailed(err);
      }
    }
  }

  load();

  return {
    destroy() {
      destroyed = true;
      clearRowTimers();
      section.removeEventListener('keydown', onKeydown);
    },
  };
}
