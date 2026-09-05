import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverToken, parseGhHostsYml } from '../src/token.js';

const noCommand = async () => { throw new Error('gh not installed'); };
const noFile = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

test('prefers GITHUB_TOKEN over everything else', async () => {
  const result = await discoverToken({
    env: { GITHUB_TOKEN: 'ghp_env', GH_TOKEN: 'ghp_other' },
    runCommand: async () => 'ghp_cli',
    readFile: noFile,
    homeDir: '/home/x',
  });
  assert.equal(result.token, 'ghp_env');
  assert.equal(result.source, 'GITHUB_TOKEN environment variable');
});

test('falls back to GH_TOKEN', async () => {
  const result = await discoverToken({
    env: { GH_TOKEN: 'ghp_other' }, runCommand: noCommand, readFile: noFile, homeDir: '/home/x',
  });
  assert.equal(result.token, 'ghp_other');
  assert.equal(result.source, 'GH_TOKEN environment variable');
});

test('falls back to the gh CLI and trims its output', async () => {
  const calls = [];
  const result = await discoverToken({
    env: {},
    runCommand: async (cmd, args) => { calls.push([cmd, args]); return 'gho_fromCliTokenValue123\n'; },
    readFile: noFile,
    homeDir: '/home/x',
  });
  assert.equal(result.token, 'gho_fromCliTokenValue123');
  assert.equal(result.source, 'GitHub CLI (gh auth token)');
  assert.deepEqual(calls, [['gh', ['auth', 'token']]]);
});

test('falls back to parsing the gh hosts file', async () => {
  const yml = [
    'github.com:',
    '    users:',
    '        someone:',
    '            oauth_token: gho_nestedTokenValue123',
    '    oauth_token: gho_hostsTokenValue123',
    '    user: someone',
    '    git_protocol: https',
  ].join('\n');
  const result = await discoverToken({
    env: {}, runCommand: noCommand, readFile: async () => yml, homeDir: '/home/x',
  });
  assert.equal(result.token, 'gho_hostsTokenValue123');
  assert.equal(result.source, 'GitHub CLI config (~/.config/gh/hosts.yml)');
});

test('returns a null token when nothing is available, without throwing', async () => {
  const result = await discoverToken({
    env: {}, runCommand: noCommand, readFile: noFile, homeDir: '/home/x',
  });
  assert.equal(result.token, null);
  assert.equal(result.source, null);
});

test('ignores gh CLI output that is not a token', async () => {
  const result = await discoverToken({
    env: {}, runCommand: async () => 'You are not logged in', readFile: noFile, homeDir: '/home/x',
  });
  assert.equal(result.token, null);
});

test('parseGhHostsYml returns the github.com token only', () => {
  const yml = 'ghe.example.com:\n    oauth_token: ghe_nope\ngithub.com:\n    oauth_token: gho_yes\n';
  assert.equal(parseGhHostsYml(yml), 'gho_yes');
  assert.equal(parseGhHostsYml('nothing: here\n'), null);
});
