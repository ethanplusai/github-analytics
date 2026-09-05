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
  constructor(driver) {
    this.driver = driver;
  }

  async close() {
    await this.driver.close();
  }

  // --- meta -----------------------------------------------------------

  async getMeta(key) {
    const row = (await this.driver.query('SELECT value FROM meta WHERE key = ?', [key]))[0] ?? null;
    return row ? row.value : null;
  }

  async setMeta(key, value) {
    await this.driver.run(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, value]);
  }

  // --- repos ------------------------------------------------------------

  async upsertRepo(repo, nowIso) {
    await this.driver.run(`
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
    `, [
      repo.fullName,
      repo.owner,
      repo.name,
      repo.private ? 1 : 0,
      repo.description ?? null,
      repo.htmlUrl ?? null,
      nowIso,
    ]);
    return this.getRepo(repo.fullName);
  }

  async getRepo(fullName) {
    const row = (await this.driver.query('SELECT * FROM repos WHERE full_name = ?', [fullName]))[0] ?? null;
    return plainRepo(row);
  }

  async getRepoById(id) {
    const row = (await this.driver.query('SELECT * FROM repos WHERE id = ?', [id]))[0] ?? null;
    return plainRepo(row);
  }

  async listRepos({ includeUntracked = false } = {}) {
    const sql = includeUntracked
      ? 'SELECT * FROM repos ORDER BY full_name'
      : 'SELECT * FROM repos WHERE tracked = 1 ORDER BY full_name';
    return (await this.driver.query(sql)).map(plainRepo);
  }

  async countTrackedRepos() {
    const rows = await this.driver.query('SELECT COUNT(*) AS c FROM repos WHERE tracked = 1');
    return rows[0].c;
  }

  async untrackRepo(fullName, nowIso) {
    const rows = await this.driver.query(`
      UPDATE repos SET tracked = 0, untracked_at = ?
      WHERE full_name = ? AND tracked = 1
      RETURNING full_name
    `, [nowIso, fullName]);
    return rows.length > 0;
  }

  async markPolled(repoId, { at, error = null }) {
    await this.driver.run('UPDATE repos SET last_polled_at = ?, last_error = ? WHERE id = ?', [at, error, repoId]);
  }

  // --- traffic ingest ---------------------------------------------------

  // Monotonic upsert: a day's count/uniques only ever rises. Returns how many
  // of the incoming points actually raised (or created) a stored value, so
  // callers can tell a no-op poll from one that moved history forward.
  //
  // GREATEST is Postgres-native and registered on SQLite by the driver.
  // This upsert is the reason the product's numbers can be trusted: a
  // truncated poll must never lower a figure already recorded.
  async ingestTrafficSeries(repoId, kind, points, nowIso) {
    if (points.length === 0) return { rows: 0, raised: 0 };

    const days = points.map((p) => dayOf(p.timestamp));
    const placeholders = days.map(() => '?').join(', ');
    const existingRows = await this.driver.query(`
      SELECT day, count, uniques FROM traffic_daily
      WHERE repo_id = ? AND kind = ? AND day IN (${placeholders})
    `, [repoId, kind, ...days]);

    const existing = new Map(existingRows.map((r) => [r.day, r]));

    let raised = 0;
    const statements = [];
    for (const point of points) {
      const day = dayOf(point.timestamp);
      const prior = existing.get(day);
      if (!prior || point.count > prior.count || point.uniques > prior.uniques) raised += 1;
      statements.push({
        sql: `
          INSERT INTO traffic_daily (repo_id, kind, day, count, uniques, first_seen_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_id, kind, day) DO UPDATE SET
            count   = GREATEST(traffic_daily.count, excluded.count),
            uniques = GREATEST(traffic_daily.uniques, excluded.uniques),
            updated_at = excluded.updated_at
        `,
        params: [repoId, kind, day, point.count, point.uniques, nowIso, nowIso],
      });
    }

    await this.driver.transaction(statements);
    return { rows: points.length, raised };
  }

  async ingestWindowSnapshot(repoId, day, kind, { count, uniques }) {
    await this.driver.run(`
      INSERT INTO window_snapshots (repo_id, day, kind, count, uniques)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, day, kind) DO UPDATE SET
        count = excluded.count, uniques = excluded.uniques
    `, [repoId, day, kind, count, uniques]);
  }

  // Referrers/paths are a rolling 14-day aggregate from GitHub, not a daily
  // figure, so each poll replaces that day's snapshot wholesale rather than
  // accumulating into it.
  async ingestReferrers(repoId, day, items) {
    const statements = [
      { sql: 'DELETE FROM referrer_snapshots WHERE repo_id = ? AND day = ?', params: [repoId, day] },
      ...items.map((item) => ({
        sql: 'INSERT INTO referrer_snapshots (repo_id, day, referrer, count, uniques) VALUES (?, ?, ?, ?, ?)',
        params: [repoId, day, item.referrer, item.count, item.uniques],
      })),
    ];
    await this.driver.transaction(statements);
  }

  async ingestPaths(repoId, day, items) {
    const statements = [
      { sql: 'DELETE FROM path_snapshots WHERE repo_id = ? AND day = ?', params: [repoId, day] },
      ...items.map((item) => ({
        sql: 'INSERT INTO path_snapshots (repo_id, day, path, title, count, uniques) VALUES (?, ?, ?, ?, ?, ?)',
        params: [repoId, day, item.path, item.title ?? null, item.count, item.uniques],
      })),
    ];
    await this.driver.transaction(statements);
  }

  // --- reads --------------------------------------------------------------

  async dailySeries(repoId, kind, sinceDay) {
    const where = sinceDay ? 'AND day >= ?' : '';
    const params = sinceDay ? [repoId, kind, sinceDay] : [repoId, kind];
    const rows = await this.driver.query(`
      SELECT day, count, uniques FROM traffic_daily
      WHERE repo_id = ? AND kind = ? ${where}
      ORDER BY day ASC
    `, params);
    return rows.map(plain);
  }

  async totals(repoId, sinceDay) {
    const where = sinceDay ? 'AND day >= ?' : '';
    const params = sinceDay ? [repoId, sinceDay] : [repoId];
    const rows = await this.driver.query(`
      SELECT ${TOTALS_SELECT}
      FROM traffic_daily WHERE repo_id = ? ${where}
    `, params);
    return plain(rows[0]);
  }

  async coverage(repoId) {
    const rows = await this.driver.query(`
      SELECT MIN(day) AS first_day, MAX(day) AS last_day, COUNT(DISTINCT day) AS days
      FROM traffic_daily WHERE repo_id = ?
    `, [repoId]);
    return plain(rows[0]);
  }

  // null means "never polled" so callers can omit the stat entirely rather
  // than render a false zero. A kind missing from an otherwise-present day's
  // snapshot (e.g. clones not yet polled) is filled with { count: 0, uniques: 0 }.
  async latestWindow(repoId) {
    const dayRows = await this.driver.query(
      'SELECT MAX(day) AS day FROM window_snapshots WHERE repo_id = ?', [repoId],
    );
    const { day } = dayRows[0];
    if (day == null) return null;
    const result = { day, views: { count: 0, uniques: 0 }, clones: { count: 0, uniques: 0 } };
    const rows = await this.driver.query(
      'SELECT kind, count, uniques FROM window_snapshots WHERE repo_id = ? AND day = ?', [repoId, day],
    );
    for (const row of rows) {
      result[row.kind] = { count: row.count, uniques: row.uniques };
    }
    return result;
  }

  // Current window plus, per referrer, the highest count ever seen and the
  // day it first appeared, kept across every snapshot that entry has had.
  async latestReferrers(repoId, limit) {
    const dayRows = await this.driver.query(
      'SELECT MAX(day) AS day FROM referrer_snapshots WHERE repo_id = ?', [repoId],
    );
    const { day } = dayRows[0];
    if (day == null) return { day: null, items: [] };
    const rows = await this.driver.query(`
      SELECT r.referrer, r.count, r.uniques,
             (SELECT MAX(count) FROM referrer_snapshots x
               WHERE x.repo_id = r.repo_id AND x.referrer = r.referrer) AS peak_count,
             (SELECT MIN(day)   FROM referrer_snapshots x
               WHERE x.repo_id = r.repo_id AND x.referrer = r.referrer) AS first_seen
      FROM referrer_snapshots r
      WHERE r.repo_id = ? AND r.day = ?
      ORDER BY r.count DESC, r.referrer ASC LIMIT ?
    `, [repoId, day, limit]);
    return { day, items: rows.map(plain) };
  }

  async latestPaths(repoId, limit) {
    const dayRows = await this.driver.query(
      'SELECT MAX(day) AS day FROM path_snapshots WHERE repo_id = ?', [repoId],
    );
    const { day } = dayRows[0];
    if (day == null) return { day: null, items: [] };
    const rows = await this.driver.query(`
      SELECT p.path, p.title, p.count, p.uniques,
             (SELECT MAX(count) FROM path_snapshots x
               WHERE x.repo_id = p.repo_id AND x.path = p.path) AS peak_count,
             (SELECT MIN(day)   FROM path_snapshots x
               WHERE x.repo_id = p.repo_id AND x.path = p.path) AS first_seen
      FROM path_snapshots p
      WHERE p.repo_id = ? AND p.day = ?
      ORDER BY p.count DESC, p.path ASC LIMIT ?
    `, [repoId, day, limit]);
    return { day, items: rows.map(plain) };
  }

  async referrerHistory(repoId, referrer) {
    const rows = await this.driver.query(`
      SELECT day, count, uniques FROM referrer_snapshots
      WHERE repo_id = ? AND referrer = ? ORDER BY day ASC
    `, [repoId, referrer]);
    return rows.map(plain);
  }

  async pathHistory(repoId, path) {
    const rows = await this.driver.query(`
      SELECT day, count, uniques FROM path_snapshots
      WHERE repo_id = ? AND path = ? ORDER BY day ASC
    `, [repoId, path]);
    return rows.map(plain);
  }

  // One assembled record per tracked repo, built from a handful of grouped
  // queries rather than per-repo lookups (this runs against ~88 repos live).
  async repoSummaries({ sinceDay = null, sparkSinceDay = null } = {}) {
    const repos = await this.driver.query('SELECT * FROM repos WHERE tracked = 1 ORDER BY full_name');

    const allTimeRows = await this.driver.query(`SELECT repo_id, ${TOTALS_SELECT} FROM traffic_daily GROUP BY repo_id`);
    const allTimeMap = new Map(allTimeRows.map((row) => [row.repo_id, stripRepoId(row)]));

    const rangeMap = sinceDay
      ? new Map(
        (await this.driver.query(
          `SELECT repo_id, ${TOTALS_SELECT} FROM traffic_daily WHERE day >= ? GROUP BY repo_id`, [sinceDay],
        )).map((row) => [row.repo_id, stripRepoId(row)]),
      )
      : allTimeMap;

    const coverageRows = await this.driver.query(`
      SELECT repo_id, MIN(day) AS first_day, MAX(day) AS last_day, COUNT(DISTINCT day) AS days
      FROM traffic_daily GROUP BY repo_id
    `);
    const coverageMap = new Map(coverageRows.map((row) => [row.repo_id, stripRepoId(row)]));

    const sparkMap = new Map();
    if (sparkSinceDay) {
      const sparkRows = await this.driver.query(
        'SELECT repo_id, kind, day, count FROM traffic_daily WHERE day >= ? ORDER BY day', [sparkSinceDay],
      );
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

  async startPollRun(nowIso) {
    const rows = await this.driver.query(
      'INSERT INTO poll_runs (started_at) VALUES (?) RETURNING id', [nowIso],
    );
    return Number(rows[0].id);
  }

  async finishPollRun(id, { total, ok, failed, at }) {
    await this.driver.run(`
      UPDATE poll_runs SET finished_at = ?, total = ?, ok = ?, failed = ? WHERE id = ?
    `, [at, total, ok, failed, id]);
  }

  async lastPollRun() {
    const row = (await this.driver.query(`
      SELECT id, started_at, finished_at, total, ok, failed FROM poll_runs
      ORDER BY id DESC LIMIT 1
    `))[0] ?? null;
    return plain(row);
  }
}
