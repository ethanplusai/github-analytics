import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, 'db', 'schema.sqlite.sql'), 'utf8');

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
