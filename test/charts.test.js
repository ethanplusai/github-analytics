import test from 'node:test';
import assert from 'node:assert/strict';
import {
  niceTicks, linearScale, buildLinePath, buildAreaPath,
  formatCount, formatFullCount, formatDayLabel, formatDayLong,
  pickDayTicks, nearestIndex, seriesColorVar, safeHref,
} from '../public/charts.js';

test('importing the chart module does not require a DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof niceTicks, 'function');
});

test('niceTicks produces clean integer ticks that span the data', () => {
  assert.deepEqual(niceTicks(0, 7, 5, { integer: true }), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(0, 3, 5, { integer: true }), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(0, 1000, 5, { integer: true }), [0, 200, 400, 600, 800, 1000]);
  assert.deepEqual(niceTicks(0, 0, 5, { integer: true }), [0, 1]);
  const big = niceTicks(0, 43210, 5, { integer: true });
  assert.equal(big[0], 0);
  assert.ok(big.at(-1) >= 43210);
  assert.ok(big.every(Number.isInteger));
});

test('linearScale maps a domain onto a range and clamps a zero-width domain', () => {
  const s = linearScale([0, 10], [0, 100]);
  assert.equal(s(0), 0);
  assert.equal(s(5), 50);
  assert.equal(s(10), 100);
  const flat = linearScale([5, 5], [0, 100]);
  assert.equal(flat(5), 0, 'a flat domain does not divide by zero');
});

test('buildLinePath and buildAreaPath produce valid SVG path data', () => {
  const pts = [{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 5 }];
  assert.equal(buildLinePath(pts), 'M0,10L10,0L20,5');
  assert.equal(buildAreaPath(pts, 30), 'M0,10L10,0L20,5L20,30L0,30Z');
  assert.equal(buildLinePath([]), '');
  assert.equal(buildAreaPath([], 30), '');
  assert.equal(buildLinePath([{ x: 1.005, y: 2.004 }]), 'M1,2', 'coordinates round to 2dp and trim zeros');
});

test('formatCount compacts large numbers and commas small ones', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1284), '1,284');
  assert.equal(formatCount(9999), '9,999');
  assert.equal(formatCount(12900), '12.9K');
  assert.equal(formatCount(120000), '120K');
  assert.equal(formatCount(999999), '1M');
  assert.equal(formatCount(4200000), '4.2M');
});

test('formatFullCount always uses grouped digits', () => {
  assert.equal(formatFullCount(0), '0');
  assert.equal(formatFullCount(1284), '1,284');
  assert.equal(formatFullCount(4200000), '4,200,000');
});

test('day labels are formatted in UTC so they never shift by timezone', () => {
  assert.equal(formatDayLabel('2026-09-04'), 'Sep 4');
  assert.equal(formatDayLabel('2026-01-01'), 'Jan 1');
  assert.match(formatDayLong('2026-09-04'), /Sep 4, 2026/);
});

test('pickDayTicks spreads labels and never crowds the last one', () => {
  assert.deepEqual(pickDayTicks([], 6), []);
  assert.deepEqual(pickDayTicks(['a'], 6), [0]);
  assert.deepEqual(pickDayTicks(['a', 'b'], 6), [0, 1]);
  assert.deepEqual(pickDayTicks(Array.from({ length: 31 }, (_, i) => i), 6), [0, 6, 12, 18, 24, 30]);
  assert.deepEqual(pickDayTicks(Array.from({ length: 10 }, (_, i) => i), 6), [0, 2, 4, 6, 9]);
});

test('nearestIndex snaps a pointer ratio to a data index', () => {
  assert.equal(nearestIndex(5, 0), 0);
  assert.equal(nearestIndex(5, 1), 4);
  assert.equal(nearestIndex(5, 0.5), 2);
  assert.equal(nearestIndex(5, -3), 0, 'clamped');
  assert.equal(nearestIndex(5, 9), 4, 'clamped');
  assert.equal(nearestIndex(0, 0.5), 0);
});

test('series colours come from the two validated slots only', () => {
  assert.equal(seriesColorVar(1), 'var(--series-1)');
  assert.equal(seriesColorVar(2), 'var(--series-2)');
  assert.throws(() => seriesColorVar(3), /slot/);
});

test('safeHref accepts http(s) and rejects everything else', () => {
  assert.equal(safeHref('https://github.com/octo/hello'), 'https://github.com/octo/hello');
  assert.equal(safeHref('http://example.com/'), 'http://example.com/');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<script>'), null);
  assert.equal(safeHref(''), null);
  assert.equal(safeHref(null), null);
});
