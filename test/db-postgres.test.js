import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDollarPlaceholders, coerceRow } from '../src/db/postgres.js';

test('rewrites ? to $n in order', () => {
  assert.equal(
    toDollarPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2',
  );
});

test('leaves a ? inside a string literal alone', () => {
  assert.equal(
    toDollarPlaceholders("SELECT * FROM t WHERE a = ? AND b = 'why?'"),
    "SELECT * FROM t WHERE a = $1 AND b = 'why?'",
  );
});

test('handles an escaped quote inside a literal', () => {
  assert.equal(
    toDollarPlaceholders("SELECT 'it''s ?' AS a, ? AS b"),
    "SELECT 'it''s ?' AS a, $1 AS b",
  );
});

test('coerces int8 and numeric columns to numbers', () => {
  const fields = [
    { name: 'c', dataTypeID: 20 },
    { name: 's', dataTypeID: 1700 },
    { name: 'day', dataTypeID: 25 },
  ];
  assert.deepEqual(
    coerceRow({ c: '88', s: '1204', day: '2026-01-01' }, fields),
    { c: 88, s: 1204, day: '2026-01-01' },
  );
});

test('leaves nulls null rather than coercing to zero', () => {
  const fields = [{ name: 'c', dataTypeID: 20 }];
  assert.deepEqual(coerceRow({ c: null }, fields), { c: null });
});
