import { dayOf } from './db.js';

function toCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// SQLite rows from node:sqlite are null-prototype objects; this turns one into
// an ordinary plain object with camelCase keys, or null if the row is absent.
function plain(row) {
  if (row == null) return null;
  const out = {};
  for (const key of Object.keys(row)) {
    out[toCamel(key)] = row[key];
  }
  return out;
}

// Repo rows additionally store `private`/`tracked` as 0/1; expose them as booleans.
function plainRepo(row) {
  const out = plain(row);
  if (out == null) return null;
  out.private = Boolean(out.private);
  out.tracked = Boolean(out.tracked);
  return out;
}

// A fresh object every call — never share one totals object across repos or
// across allTime/range, so later per-repo enrichment can't mutate one repo's
// data through another's reference (or throw on a frozen shared object).
const zeroTotals = () => ({ clones: 0, uniqueCloners: 0, views: 0, uniqueVisitors: 0 });

const TOTALS_SELECT = `
  COALESCE(SUM(CASE WHEN kind='clones' THEN count END), 0)   AS clones,
  COALESCE(SUM(CASE WHEN kind='clones' THEN uniques END), 0) AS unique_cloners,
  COALESCE(SUM(CASE WHEN kind='views'  THEN count END), 0)   AS views,
  COALESCE(SUM(CASE WHEN kind='views'  THEN uniques END), 0) AS unique_visitors
`;

// Grouped queries carry repo_id along for grouping; this strips it back out
// so the stored value has only the columns the caller asked for.
function stripRepoId(row) {
  const { repoId, ...rest } = plain(row);
  return rest;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  // --- meta -----------------------------------------------------------

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  // --- repos ------------------------------------------------------------

  upsertRepo(repo, nowIso) {
    this.db.prepare(`
      INSERT INTO repos (full_name, owner, name, private, description, html_url, tracked, added_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(full_name) DO UPDATE SET
        owner = excluded.owner,
        name = excluded.name,
        private = excluded.private,
        description = COALESCE(excluded.description, repos.description),
        html_url = COALESCE(excluded.html_url, repos.html_url),
        tracked = 1,
        untracked_at = NULL
    `).run(
      repo.fullName,
      repo.owner,
      repo.name,
      repo.private ? 1 : 0,
      repo.description ?? null,
      repo.htmlUrl ?? null,
      nowIso,
    );
    return this.getRepo(repo.fullName);
  }

  getRepo(fullName) {
    return plainRepo(this.db.prepare('SELECT * FROM repos WHERE full_name = ?').get(fullName));
  }

  getRepoById(id) {
    return plainRepo(this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id));
  }

  listRepos({ includeUntracked = false } = {}) {
    const sql = includeUntracked
      ? 'SELECT * FROM repos ORDER BY full_name'
      : 'SELECT * FROM repos WHERE tracked = 1 ORDER BY full_name';
    return this.db.prepare(sql).all().map(plainRepo);
  }

  countTrackedRepos() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM repos WHERE tracked = 1').get().c;
  }

  untrackRepo(fullName, nowIso) {
    const result = this.db.prepare(`
      UPDATE repos SET tracked = 0, untracked_at = ?
      WHERE full_name = ? AND tracked = 1
    `).run(nowIso, fullName);
    return result.changes > 0;
  }

  markPolled(repoId, { at, error = null }) {
    this.db.prepare('UPDATE repos SET last_polled_at = ?, last_error = ? WHERE id = ?')
      .run(at, error, repoId);
  }

  // --- traffic ingest ---------------------------------------------------

  // Monotonic upsert: a day's count/uniques only ever rises. Returns how many
  // of the incoming points actually raised (or created) a stored value, so
  // callers can tell a no-op poll from one that moved history forward.
  ingestTrafficSeries(repoId, kind, points, nowIso) {
    const selectExisting = this.db.prepare(
      'SELECT count, uniques FROM traffic_daily WHERE repo_id = ? AND kind = ? AND day = ?',
    );
    const upsert = this.db.prepare(`
      INSERT INTO traffic_daily (repo_id, kind, day, count, uniques, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, kind, day) DO UPDATE SET
        count   = MAX(traffic_daily.count, excluded.count),
        uniques = MAX(traffic_daily.uniques, excluded.uniques),
        updated_at = excluded.updated_at
    `);

    let raised = 0;
    this.db.exec('BEGIN');
    try {
      for (const point of points) {
        const day = dayOf(point.timestamp);
        const existing = selectExisting.get(repoId, kind, day);
        if (!existing || point.count > existing.count || point.uniques > existing.uniques) {
          raised += 1;
        }
        upsert.run(repoId, kind, day, point.count, point.uniques, nowIso, nowIso);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { rows: points.length, raised };
  }

  ingestWindowSnapshot(repoId, day, kind, { count, uniques }) {
    this.db.prepare(`
      INSERT INTO window_snapshots (repo_id, day, kind, count, uniques)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, day, kind) DO UPDATE SET
        count = excluded.count, uniques = excluded.uniques
    `).run(repoId, day, kind, count, uniques);
  }

  // Referrers/paths are a rolling 14-day aggregate from GitHub, not a daily
  // figure, so each poll replaces that day's snapshot wholesale rather than
  // accumulating into it.
  ingestReferrers(repoId, day, items) {
    const del = this.db.prepare('DELETE FROM referrer_snapshots WHERE repo_id = ? AND day = ?');
    const ins = this.db.prepare(
      'INSERT INTO referrer_snapshots (repo_id, day, referrer, count, uniques) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      del.run(repoId, day);
      for (const item of items) {
        ins.run(repoId, day, item.referrer, item.count, item.uniques);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  ingestPaths(repoId, day, items) {
    const del = this.db.prepare('DELETE FROM path_snapshots WHERE repo_id = ? AND day = ?');
    const ins = this.db.prepare(
      'INSERT INTO path_snapshots (repo_id, day, path, title, count, uniques) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      del.run(repoId, day);
      for (const item of items) {
        ins.run(repoId, day, item.path, item.title ?? null, item.count, item.uniques);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- reads --------------------------------------------------------------

  dailySeries(repoId, kind, sinceDay) {
    const where = sinceDay ? 'AND day >= ?' : '';
    const params = sinceDay ? [repoId, kind, sinceDay] : [repoId, kind];
    return this.db.prepare(`
      SELECT day, count, uniques FROM traffic_daily
      WHERE repo_id = ? AND kind = ? ${where}
      ORDER BY day ASC
    `).all(...params).map(plain);
  }

  totals(repoId, sinceDay) {
    const where = sinceDay ? 'AND day >= ?' : '';
    const params = sinceDay ? [repoId, sinceDay] : [repoId];
    const row = this.db.prepare(`
      SELECT ${TOTALS_SELECT}
      FROM traffic_daily WHERE repo_id = ? ${where}
    `).get(...params);
    return plain(row);
  }

  coverage(repoId) {
    const row = this.db.prepare(`
      SELECT MIN(day) AS first_day, MAX(day) AS last_day, COUNT(DISTINCT day) AS days
      FROM traffic_daily WHERE repo_id = ?
    `).get(repoId);
    return plain(row);
  }

  // null means "never polled" so callers can omit the stat entirely rather
  // than render a false zero. A kind missing from an otherwise-present day's
  // snapshot (e.g. clones not yet polled) is filled with { count: 0, uniques: 0 }.
  latestWindow(repoId) {
    const { day } = this.db.prepare('SELECT MAX(day) AS day FROM window_snapshots WHERE repo_id = ?').get(repoId);
    if (day == null) return null;
    const result = { day, views: { count: 0, uniques: 0 }, clones: { count: 0, uniques: 0 } };
    const rows = this.db.prepare(
      'SELECT kind, count, uniques FROM window_snapshots WHERE repo_id = ? AND day = ?',
    ).all(repoId, day);
    for (const row of rows) {
      result[row.kind] = { count: row.count, uniques: row.uniques };
    }
    return result;
  }

  // Current window plus, per referrer, the highest count ever seen and the
  // day it first appeared, kept across every snapshot that entry has had.
  latestReferrers(repoId, limit) {
    const { day } = this.db.prepare('SELECT MAX(day) AS day FROM referrer_snapshots WHERE repo_id = ?').get(repoId);
    if (day == null) return { day: null, items: [] };
    const rows = this.db.prepare(`
      SELECT r.referrer, r.count, r.uniques,
             (SELECT MAX(count) FROM referrer_snapshots x
               WHERE x.repo_id = r.repo_id AND x.referrer = r.referrer) AS peak_count,
             (SELECT MIN(day)   FROM referrer_snapshots x
               WHERE x.repo_id = r.repo_id AND x.referrer = r.referrer) AS first_seen
      FROM referrer_snapshots r
      WHERE r.repo_id = ? AND r.day = ?
      ORDER BY r.count DESC, r.referrer ASC LIMIT ?
    `).all(repoId, day, limit);
    return { day, items: rows.map(plain) };
  }

  latestPaths(repoId, limit) {
    const { day } = this.db.prepare('SELECT MAX(day) AS day FROM path_snapshots WHERE repo_id = ?').get(repoId);
    if (day == null) return { day: null, items: [] };
    const rows = this.db.prepare(`
      SELECT p.path, p.title, p.count, p.uniques,
             (SELECT MAX(count) FROM path_snapshots x
               WHERE x.repo_id = p.repo_id AND x.path = p.path) AS peak_count,
             (SELECT MIN(day)   FROM path_snapshots x
               WHERE x.repo_id = p.repo_id AND x.path = p.path) AS first_seen
      FROM path_snapshots p
      WHERE p.repo_id = ? AND p.day = ?
      ORDER BY p.count DESC, p.path ASC LIMIT ?
    `).all(repoId, day, limit);
    return { day, items: rows.map(plain) };
  }

  referrerHistory(repoId, referrer) {
    return this.db.prepare(`
      SELECT day, count, uniques FROM referrer_snapshots
      WHERE repo_id = ? AND referrer = ? ORDER BY day ASC
    `).all(repoId, referrer).map(plain);
  }

  pathHistory(repoId, path) {
    return this.db.prepare(`
      SELECT day, count, uniques FROM path_snapshots
      WHERE repo_id = ? AND path = ? ORDER BY day ASC
    `).all(repoId, path).map(plain);
  }

  // One assembled record per tracked repo, built from a handful of grouped
  // queries rather than per-repo lookups (this runs against ~88 repos live).
  repoSummaries({ sinceDay = null, sparkSinceDay = null } = {}) {
    const repos = this.db.prepare('SELECT * FROM repos WHERE tracked = 1 ORDER BY full_name').all();

    const allTimeMap = new Map(
      this.db.prepare(`SELECT repo_id, ${TOTALS_SELECT} FROM traffic_daily GROUP BY repo_id`)
        .all()
        .map((row) => [row.repo_id, stripRepoId(row)]),
    );

    const rangeMap = sinceDay
      ? new Map(
        this.db.prepare(`SELECT repo_id, ${TOTALS_SELECT} FROM traffic_daily WHERE day >= ? GROUP BY repo_id`)
          .all(sinceDay)
          .map((row) => [row.repo_id, stripRepoId(row)]),
      )
      : allTimeMap;

    const coverageMap = new Map(
      this.db.prepare(`
        SELECT repo_id, MIN(day) AS first_day, MAX(day) AS last_day, COUNT(DISTINCT day) AS days
        FROM traffic_daily GROUP BY repo_id
      `).all().map((row) => [row.repo_id, stripRepoId(row)]),
    );

    const sparkMap = new Map();
    if (sparkSinceDay) {
      const sparkRows = this.db.prepare(
        'SELECT repo_id, kind, day, count FROM traffic_daily WHERE day >= ? ORDER BY day',
      ).all(sparkSinceDay);
      for (const row of sparkRows) {
        let byDay = sparkMap.get(row.repo_id);
        if (!byDay) {
          byDay = new Map();
          sparkMap.set(row.repo_id, byDay);
        }
        let entry = byDay.get(row.day);
        if (!entry) {
          entry = { views: 0, clones: 0 };
          byDay.set(row.day, entry);
        }
        entry[row.kind] = row.count;
      }
    }

    return repos.map((repoRow) => {
      const repo = plainRepo(repoRow);
      const byDay = sparkMap.get(repo.id);
      const days = byDay ? [...byDay.keys()].sort() : [];
      return {
        id: repo.id,
        fullName: repo.fullName,
        owner: repo.owner,
        name: repo.name,
        private: repo.private,
        description: repo.description,
        htmlUrl: repo.htmlUrl,
        addedAt: repo.addedAt,
        lastPolledAt: repo.lastPolledAt,
        lastError: repo.lastError,
        allTime: allTimeMap.get(repo.id) ?? zeroTotals(),
        range: rangeMap.get(repo.id) ?? zeroTotals(),
        coverage: coverageMap.get(repo.id) ?? { firstDay: null, lastDay: null, days: 0 },
        spark: {
          days,
          views: days.map((d) => byDay.get(d).views),
          clones: days.map((d) => byDay.get(d).clones),
        },
      };
    });
  }

  // --- poll runs ------------------------------------------------------

  startPollRun(nowIso) {
    const result = this.db.prepare('INSERT INTO poll_runs (started_at) VALUES (?)').run(nowIso);
    return Number(result.lastInsertRowid);
  }

  finishPollRun(id, { total, ok, failed, at }) {
    this.db.prepare(`
      UPDATE poll_runs SET finished_at = ?, total = ?, ok = ?, failed = ? WHERE id = ?
    `).run(at, total, ok, failed, id);
  }

  lastPollRun() {
    const row = this.db.prepare(`
      SELECT id, started_at, finished_at, total, ok, failed FROM poll_runs
      ORDER BY id DESC LIMIT 1
    `).get();
    return plain(row);
  }
}
