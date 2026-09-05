import { execFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TOKEN_SHAPE = /^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}$/;

async function defaultRunCommand(cmd, args) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, encoding: 'utf8' });
  return stdout;
}

export function parseGhHostsYml(text) {
  const lines = String(text).split(/\r?\n/);
  let inHost = false;
  let blockIndent = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inHost = /^github\.com:\s*$/.test(line);
      blockIndent = null;
      continue;
    }
    if (!inHost || !line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (blockIndent === null) blockIndent = indent;
    if (indent !== blockIndent) continue;
    const m = line.match(/^\s*oauth_token:\s*(\S+)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

export async function discoverToken({
  env = process.env,
  runCommand = defaultRunCommand,
  readFile = fsReadFile,
  homeDir = homedir(),
} = {}) {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: 'GITHUB_TOKEN environment variable' };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: 'GH_TOKEN environment variable' };

  try {
    const out = (await runCommand('gh', ['auth', 'token'])).trim();
    if (TOKEN_SHAPE.test(out)) return { token: out, source: 'GitHub CLI (gh auth token)' };
  } catch { /* gh missing or logged out — keep looking */ }

  const hostsPath = env.GH_CONFIG_DIR
    ? join(env.GH_CONFIG_DIR, 'hosts.yml')
    : join(homeDir, '.config', 'gh', 'hosts.yml');
  try {
    const token = parseGhHostsYml(await readFile(hostsPath, 'utf8'));
    if (token && TOKEN_SHAPE.test(token)) {
      return { token, source: 'GitHub CLI config (~/.config/gh/hosts.yml)' };
    }
  } catch { /* no hosts file — fall through */ }

  return { token: null, source: null };
}
