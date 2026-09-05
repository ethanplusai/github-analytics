import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL UNIQUE,
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,
  private       INTEGER NOT NULL DEFAULT 0,
  description   TEXT,
  html_url      TEXT,
  tracked       INTEGER NOT NULL DEFAULT 1,
  added_at      TEXT NOT NULL,
  untracked_at  TEXT,
  last_polled_at TEXT,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_repos_tracked ON repos(tracked);

CREATE TABLE IF NOT EXISTS traffic_daily (
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('clones','views')),
  day           TEXT NOT NULL,
  count         INTEGER NOT NULL,
  uniques       INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (repo_id, kind, day)
);

CREATE TABLE IF NOT EXISTS window_snapshots (
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('clones','views')),
  count    INTEGER NOT NULL,
  uniques  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, day, kind)
);

CREATE TABLE IF NOT EXISTS referrer_snapshots (
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  referrer TEXT NOT NULL,
  count    INTEGER NOT NULL,
  uniques  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, day, referrer)
);

CREATE TABLE IF NOT EXISTS path_snapshots (
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  path     TEXT NOT NULL,
  title    TEXT,
  count    INTEGER NOT NULL,
  uniques  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, day, path)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0
);
`;

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  db.exec('PRAGMA user_version = 1');
  return db;
}

export function dayOf(isoTimestamp) {
  return String(isoTimestamp).slice(0, 10);
}

export function todayUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function daysAgoUtc(date, n) {
  const d = new Date(date.getTime() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
