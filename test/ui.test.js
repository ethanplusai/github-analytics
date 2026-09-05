import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relativeTime, sortRepos, filterRepos, pluralise, noticeKey, isDeliberateConfirm,
} from '../public/ui.js';

const NOW = new Date('2026-09-04T12:00:00Z');

test('relativeTime reads naturally at every scale', () => {
  assert.equal(relativeTime(null, NOW), 'never');
  assert.equal(relativeTime('2026-09-04T11:59:30Z', NOW), 'just now');
  assert.equal(relativeTime('2026-09-04T11:55:00Z', NOW), '5 min ago');
  assert.equal(relativeTime('2026-09-04T10:00:00Z', NOW), '2 hours ago');
  assert.equal(relativeTime('2026-09-04T11:00:00Z', NOW), '1 hour ago');
  assert.equal(relativeTime('2026-09-01T12:00:00Z', NOW), '3 days ago');
  assert.equal(relativeTime('2026-06-04T12:00:00Z', NOW), 'Jun 4');
  assert.equal(relativeTime('2024-06-04T12:00:00Z', NOW), 'Jun 4, 2024');
});

test('pluralise picks the right word', () => {
  assert.equal(pluralise(1, 'repository', 'repositories'), '1 repository');
  assert.equal(pluralise(0, 'repository', 'repositories'), '0 repositories');
  assert.equal(pluralise(88, 'repository', 'repositories'), '88 repositories');
});

const REPOS = [
  { fullName: 'octo/beta', name: 'beta', owner: 'octo', description: 'Charting library',
    range: { views: 10, clones: 9 }, allTime: { views: 10, clones: 9 }, lastPolledAt: '2026-09-04T11:00:00Z' },
  { fullName: 'octo/alpha', name: 'alpha', owner: 'octo', description: null,
    range: { views: 50, clones: 1 }, allTime: { views: 50, clones: 1 }, lastPolledAt: '2026-09-04T09:00:00Z' },
  { fullName: 'octo/gamma', name: 'gamma', owner: 'octo', description: 'A quiet repo',
    range: { views: 0, clones: 0 }, allTime: { views: 0, clones: 0 }, lastPolledAt: null },
];

test('sortRepos orders by each key without mutating the input', () => {
  const before = REPOS.map((r) => r.fullName);
  assert.deepEqual(sortRepos(REPOS, 'views').map((r) => r.fullName), ['octo/alpha', 'octo/beta', 'octo/gamma']);
  assert.deepEqual(sortRepos(REPOS, 'clones').map((r) => r.fullName), ['octo/beta', 'octo/alpha', 'octo/gamma']);
  assert.deepEqual(sortRepos(REPOS, 'name').map((r) => r.fullName), ['octo/alpha', 'octo/beta', 'octo/gamma']);
  assert.deepEqual(sortRepos(REPOS, 'polled').map((r) => r.fullName), ['octo/beta', 'octo/alpha', 'octo/gamma']);
  assert.deepEqual(REPOS.map((r) => r.fullName), before, 'input untouched');
});

test('sortRepos falls back to name for an unknown key and breaks ties by name', () => {
  assert.deepEqual(sortRepos(REPOS, 'nonsense').map((r) => r.fullName), ['octo/alpha', 'octo/beta', 'octo/gamma']);
});

test('filterRepos matches name and description, case-insensitively', () => {
  assert.equal(filterRepos(REPOS, '').length, 3);
  assert.equal(filterRepos(REPOS, '  ').length, 3);
  assert.deepEqual(filterRepos(REPOS, 'ALPH').map((r) => r.name), ['alpha']);
  assert.deepEqual(filterRepos(REPOS, 'charting').map((r) => r.name), ['beta']);
  assert.deepEqual(filterRepos(REPOS, 'octo/').map((r) => r.name), ['beta', 'alpha', 'gamma']);
  assert.deepEqual(filterRepos(REPOS, 'zzz'), []);
});

test('noticeKey is stable per kind so a dismissal sticks', () => {
  assert.equal(noticeKey('no_token'), 'gha-notice-no_token');
  assert.notEqual(noticeKey('no_token'), noticeKey('rate_limited'));
});

test('isDeliberateConfirm rejects a double-click but accepts a real second click', () => {
  assert.equal(isDeliberateConfirm(null, 5000), false, 'not armed yet');
  assert.equal(isDeliberateConfirm(1000, 1000), false, 'same tick — a double-click');
  assert.equal(isDeliberateConfirm(1000, 1200), false, 'still inside the cooldown');
  assert.equal(isDeliberateConfirm(1000, 1400), true, 'a deliberate second click');
  assert.equal(isDeliberateConfirm(1000, 1100, 50), true, 'cooldown is configurable');
});
