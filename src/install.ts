import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export function claudeSnippet(): string {
  const snippet = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'vlite stop-check', timeout: 3600 }] }],
    },
  };
  return [
    'Add this to .claude/settings.json (merge with what is there):',
    JSON.stringify(snippet, null, 2),
    `If vlite is not on PATH, use this command instead: ${vliteCommand()} stop-check`,
  ].join('\n');
}
