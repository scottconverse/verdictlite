import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ConnectOpts {
  claudeHome?: string;
  codexHome?: string;
  apps: ('claude' | 'codex')[];
  uninstall?: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Bare `node` works in bash, cmd and PowerShell. The cli path is absolute. */
function hookCommand(): string {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js').replace(/\\/g, '/');
  return `node "${cli}" stop-check --global`;
}

const isGlobalStop = (c: unknown): boolean => typeof c === 'string' && c.includes('stop-check') && c.includes('--global');
const isOurs = (c: unknown): boolean => isGlobalStop(c) && (c as string).replace(/\\/g, '/').includes('dist/cli.js');

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function snippet(command: string): string {
  const doc = { hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 2400 }] }] } };
  return JSON.stringify(doc, null, 2);
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.vlite-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function handlers(group: unknown): Json[] | null {
  if (!isObj(group) || !Array.isArray(group.hooks)) return null;
  return group.hooks.filter(isObj);
}

function connectOne(label: string, file: string, uninstall: boolean, command: string): string[] {
  const notes: string[] = [];
  let doc: Json = {};
  const exists = existsSync(file);
  if (exists) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (!isObj(parsed)) throw new Error('the top level is not an object');
      doc = parsed;
    } catch (e) {
      notes.push(`${label}: ${file} is not valid JSON (${(e as Error).message}). I did not change it.`);
      if (!uninstall) notes.push(`Add this by hand:\n${snippet(command)}`);
      return notes;
    }
  } else if (uninstall) {
    notes.push(`${label}: ${file} does not exist, nothing to remove`);
    return notes;
  }
  const hooks = doc.hooks;
  const stop = isObj(hooks) ? hooks.Stop : undefined;
  if ((hooks !== undefined && !isObj(hooks)) || (stop !== undefined && !Array.isArray(stop))) {
    notes.push(`${label}: "hooks" or "hooks.Stop" in ${file} has an unexpected type. I did not change it.`);
    if (!uninstall) notes.push(`Add this by hand:\n${snippet(command)}`);
    return notes;
  }
  const groups: unknown[] = (stop as unknown[] | undefined) ?? [];

  if (uninstall) {
    let removed = 0;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!handlers(g) || !isObj(g)) {
        kept.push(g);
        continue;
      }
      const all = g.hooks as unknown[];
      const left = all.filter((h) => !(isObj(h) && isOurs(h.command)));
      removed += all.length - left.length;
      if (left.length === all.length) kept.push(g);
      else if (left.length > 0) kept.push({ ...g, hooks: left });
    }
    if (removed === 0) {
      notes.push(`${label}: VerdictLite hook not found in ${file}, left alone`);
      return notes;
    }
    const hk: Json = { ...(hooks as Json) };
    if (kept.length > 0) hk.Stop = kept;
    else delete hk.Stop;
    const next: Json = { ...doc };
    if (Object.keys(hk).length > 0) next.hooks = hk;
    else delete next.hooks;
    const backup = `${file}.vlite-backup-${stamp()}`;
    copyFileSync(file, backup);
    writeAtomic(file, next);
    notes.push(`${label}: removed the VerdictLite hook from ${file} (backup: ${backup})`);
    return notes;
  }

  if (groups.some((g) => handlers(g)?.some((h) => isGlobalStop(h.command)))) {
    notes.push(`${label}: already connected (${file})`);
    return notes;
  }
  const group = { hooks: [{ type: 'command', command, timeout: 2400 }] };
  const next: Json = { ...doc, hooks: { ...(isObj(hooks) ? hooks : {}), Stop: [...groups, group] } };
  mkdirSync(dirname(file), { recursive: true });
  if (exists) {
    const backup = `${file}.vlite-backup-${stamp()}`;
    copyFileSync(file, backup);
    notes.push(`${label}: backed up ${file} to ${backup}`);
  }
  writeAtomic(file, next);
  notes.push(`${label}: connected. Hook added to ${file}`);
  return notes;
}

export function connect(opts: ConnectOpts): string[] {
  const uninstall = opts.uninstall ?? false;
  const command = hookCommand();
  const notes: string[] = [];
  if (opts.apps.includes('claude')) {
    const home = opts.claudeHome ?? join(homedir(), '.claude');
    if (!existsSync(home)) notes.push('Claude Code not found');
    else notes.push(...connectOne('Claude Code', join(home, 'settings.json'), uninstall, command));
  }
  if (opts.apps.includes('codex')) {
    const home = opts.codexHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
    if (!existsSync(home)) notes.push('Codex not found');
    else {
      const toml = join(home, 'config.toml');
      if (existsSync(toml) && /^\s*\[\[?hooks/m.test(readFileSync(toml, 'utf8'))) {
        notes.push(`Codex: ${toml} already has hooks. Codex warns when two places define hooks, so I did not write hooks.json.`);
        if (!uninstall) notes.push(`Add the VerdictLite Stop hook to ${toml} by hand. The command is:\n${command}`);
      } else {
        notes.push(...connectOne('Codex', join(home, 'hooks.json'), uninstall, command));
        if (!uninstall) notes.push('Codex runs a new hook only after you approve it: in Codex, click Review hooks in the message box, or open Settings > Hooks.');
      }
    }
  }
  return notes;
}
