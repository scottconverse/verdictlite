import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { HOOK_TIMEOUT_SEC } from './connect.js';
import { gitOut } from './git.js';
import { UsageError } from './stamp.js';

const MARK = '# vlite-hook (VerdictLite)';
const HOOKS = ['pre-commit', 'commit-msg'] as const;

const sh = (p: string): string => `"${p.replace(/\\/g, '/').replace(/(["$`])/g, '\\$1')}"`;

/** The hook calls this exact node and cli file, so it works without vlite on PATH (Git Bash, PowerShell, CI). */
function vliteCommand(): string {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  return `${sh(process.execPath)} ${sh(cli)}`;
}

function hookScript(name: (typeof HOOKS)[number]): string {
  const call = name === 'pre-commit' ? 'gate pre-commit' : 'gate commit-msg "$1"';
  return [
    '#!/bin/sh',
    MARK,
    `prev="$(dirname "$0")/${name}.vlite-prev"`,
    'if [ -f "$prev" ]; then "$prev" "$@" || exit $?; fi',
    `exec ${vliteCommand()} ${call}`,
    '',
  ].join('\n');
}

export function hooksDir(root: string): string {
  // --git-path hooks honours core.hooksPath and points at the common dir for linked worktrees.
  return resolve(root, gitOut(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']));
}

export function install(root: string, uninstall: boolean): string[] {
  const dir = hooksDir(root);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  for (const name of HOOKS) {
    const path = join(dir, name);
    const prev = `${path}.vlite-prev`;
    const ours = existsSync(path) && readFileSync(path, 'utf8').includes(MARK);
    if (uninstall) {
      if (ours) rmSync(path);
      if (existsSync(prev) && !existsSync(path)) {
        renameSync(prev, path);
        notes.push(`${name}: removed, restored the previous hook`);
      } else notes.push(ours ? `${name}: removed` : `${name}: not installed, left alone`);
      continue;
    }
    if (existsSync(path) && !ours) {
      if (existsSync(prev)) throw new UsageError(`${path} is not ours and ${prev} already exists. Move one of them by hand.`);
      renameSync(path, prev);
      notes.push(`${name}: kept the existing hook as ${name}.vlite-prev; it runs first`);
    }
    writeFileSync(path, hookScript(name), { encoding: 'utf8' });
    chmodSync(path, 0o755);
    notes.push(`${name}: ${ours ? 'updated' : 'installed'} in ${dir}`);
  }
  return notes;
}

/**
 * A warning when the checks in vlite.json can add up to more than the Stop hook timeout (the app would kill the hook
 * before it writes a verdict). A template part counts its checks times maxExpandedParts. Null when fine; never throws.
 */
export function hookTimeoutWarning(root: string): string | null {
  try {
    const loaded = loadConfig(root);
    if (!loaded) return null;
    const { parts, maxExpandedParts } = loaded.config;
    let total = 0;
    for (const p of parts) total += p.checks.reduce((n, c) => n + c.timeoutSec, 0) * (p.template ? maxExpandedParts : 1);
    if (total <= HOOK_TIMEOUT_SEC) return null;
    return `Warning: the check timeouts in vlite.json add up to ${total} s (a template part counts its checks times maxExpandedParts, ${maxExpandedParts}), more than the Stop hook timeout of ${HOOK_TIMEOUT_SEC} s. The app can kill the hook before a verdict is written. Lower the check timeouts, or raise the hook timeout in the app settings.`;
  } catch {
    return null; // a config problem must never make install fail
  }
}

export function claudeSnippet(): string {
  const snippet = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'vlite stop-check', timeout: HOOK_TIMEOUT_SEC }] }],
    },
  };
  return [
    'Add this to .claude/settings.json (merge with what is there):',
    JSON.stringify(snippet, null, 2),
    `If vlite is not on PATH, use this command instead: ${vliteCommand()} stop-check`,
  ].join('\n');
}
