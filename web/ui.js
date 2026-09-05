// web/ui.js
//
// Pure DOM/data helpers shared by app.js and the views. `el` is the only
// export that touches `document`; every other export is a pure function so
// it can run — and be unit-tested — under plain Node with no DOM at all.

/** `n` plus the singular or plural word, chosen by `n === 1`. */
export function pluralise(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A short, human, UTC-based relative time string. `now` defaults to the
 * current time but is always overridable so callers (and tests) can pin it.
 */
export function relativeTime(iso, now = new Date()) {
  if (!iso) return 'never';

  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();

  if (diffMs < 60_000) return 'just now';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${pluralise(hours, 'hour', 'hours')} ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days < 30) return `${pluralise(days, 'day', 'days')} ago`;

  const sameYear = then.getUTCFullYear() === now.getUTCFullYear();
  return then.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

const DIRECT_PROPS = ['className', 'id', 'type', 'href', 'title', 'disabled', 'tabIndex'];

/**
 * A minimal `document.createElement` wrapper. This is the only export that
 * touches the DOM, and it is deliberately narrow: no `innerHTML` path
 * exists here at all, so untrusted strings can only ever land via
 * `textContent` (through `props.text` or a plain-string child).
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const key of DIRECT_PROPS) {
    if (props[key] !== undefined) node[key] = props[key];
  }

  if (props.dataset) {
    for (const [k, v] of Object.entries(props.dataset)) {
      node.dataset[k] = v;
    }
  }

  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === undefined || v === null) continue;
      node.setAttribute(k, v);
    }
  }

  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      node.addEventListener(type, handler);
    }
  }

  if (props.text !== undefined) {
    node.textContent = props.text;
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

/** Removes every child of `node`. */
export function clear(node) {
  node.replaceChildren();
}

const SORTERS = {
  views: (a, b) => (b.range?.views ?? 0) - (a.range?.views ?? 0),
  clones: (a, b) => (b.range?.clones ?? 0) - (a.range?.clones ?? 0),
  polled: (a, b) => {
    if (!a.lastPolledAt && !b.lastPolledAt) return 0;
    if (!a.lastPolledAt) return 1;
    if (!b.lastPolledAt) return -1;
    return new Date(b.lastPolledAt).getTime() - new Date(a.lastPolledAt).getTime();
  },
};

/**
 * Returns a sorted copy of `repos`. `key` is one of 'views', 'clones',
 * 'polled', or 'name'; anything else falls back to 'name'. Every comparator
 * breaks ties by `fullName` ascending, so the result is always fully
 * deterministic.
 */
function compareName(a, b) {
  return a.fullName.localeCompare(b.fullName, undefined, { sensitivity: 'base' });
}

export function sortRepos(repos, key) {
  const primary = Object.hasOwn(SORTERS, key) ? SORTERS[key] : undefined;
  const copy = [...repos];
  copy.sort((a, b) => {
    const primaryResult = primary ? primary(a, b) : 0;
    if (primaryResult !== 0) return primaryResult;
    return compareName(a, b);
  });
  return copy;
}

/**
 * Case-insensitive substring match against `fullName` and `description`.
 * An empty (or whitespace-only) query returns `repos` unchanged.
 */
export function filterRepos(repos, query) {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter((r) => {
    const name = (r.fullName || '').toLowerCase();
    const desc = (r.description || '').toLowerCase();
    return name.includes(q) || desc.includes(q);
  });
}

/** A stable per-kind key so a notice dismissal persists across renders. */
export function noticeKey(kind) {
  return `gha-notice-${kind}`;
}

/**
 * Guards the second click of a two-step inline confirmation.
 *
 * A two-click confirm is only a safety mechanism if the two clicks are two
 * decisions. An ordinary double-click — or holding Enter on a focused button,
 * which browsers auto-repeat — delivers both clicks in a few milliseconds and
 * would otherwise arm and fire a destructive action with no confirmation ever
 * having happened. Requiring a short gap makes the second click deliberate.
 *
 * @param {number|null} armedAt  when the first click armed the control, or null
 * @param {number} nowMs         the current time
 * @param {number} [cooldownMs]  the minimum gap that counts as a second decision
 */
export function isDeliberateConfirm(armedAt, nowMs, cooldownMs = 400) {
  if (armedAt === null || armedAt === undefined) return false;
  return nowMs - armedAt >= cooldownMs;
}

/**
 * The clone-ratio explainer sentence for the repo detail page.
 *
 * `ratio` is total clones divided by `uniqueCloners` *summed over the
 * range* — GitHub's daily unique-cloner count, added up day by day. A
 * person who clones on three separate days is counted three times, so the
 * denominator is unique-cloner-*days*, never a headcount of distinct
 * people. The copy below says "actor", not "person"/"individual"/"user",
 * precisely so it can't be misread as one.
 *
 * Returns null when there's nothing to explain (no cloners in range), so
 * callers can render nothing rather than a placeholder dash.
 */
export function formatCloneRatio(ratio) {
  if (ratio === null || ratio === undefined) return null;
  const value = ratio.toFixed(1);
  if (ratio === 1) {
    return `${value} clones per unique cloner — no repeat cloning in this range.`;
  }
  return `${value} clones per unique cloner — one actor cloning repeatedly, typically CI or a deploy system.`;
}
