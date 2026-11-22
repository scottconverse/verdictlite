import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vliteHome } from './state.js';

export interface ConnectOpts {
  claudeHome?: string;
  codexHome?: string;
  apps: ('claude' | 'codex')[];
  uninstall?: boolean;
}

/** Timeout, in seconds, of the Stop hook that `vlite connect` and `vlite install --claude` write. Checks run one at a time and must fit inside it. */
export const HOOK_TIMEOUT_SEC = 3600;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Bare `node` works in bash, cmd and PowerShell. The cli path is absolute. */
function hookCommand(codex: boolean): string {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js').replace(/\\/g, '/');
  return `node "${cli}" stop-check --global${codex ? ' --codex' : ''}`;
}

const isGlobalStop = (c: unknown): boolean => typeof c === 'string' && c.includes('stop-check') && c.includes('--global');
const isOurs = (c: unknown): boolean => isGlobalStop(c) && (c as string).replace(/\\/g, '/').includes('dist/cli.js');

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function snippet(command: string): string {
  const doc = { hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] }] } };
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

  const global = groups.flatMap((g) => handlers(g) ?? []).filter((h) => isGlobalStop(h.command));
  if (global.length > 0) {
    // Our own entry is repaired when its command or timeout differs from today's. A custom command that is not ours stays untouched.
    const stale = global.filter((h) => isOurs(h.command) && (h.command !== command || h.timeout !== HOOK_TIMEOUT_SEC));
    if (stale.length === 0) {
      notes.push(`${label}: already connected (${file})`);
      return notes;
    }
    const was = stale.map((h) => `command ${String(h.command)}, timeout ${String(h.timeout)}`).join('; ');
    for (const h of stale) {
      h.command = command;
      h.timeout = HOOK_TIMEOUT_SEC;
    }
    const backup = `${file}.vlite-backup-${stamp()}`;
    copyFileSync(file, backup);
    writeAtomic(file, doc);
    notes.push(`${label}: updated the VerdictLite hook in ${file} (was: ${was}; now: command ${command}, timeout ${HOOK_TIMEOUT_SEC}). Backup: ${backup}`);
    return notes;
  }
  const group = { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] };
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

/** Marker: the person disconnected on purpose. The installer reads it and does not connect again by itself. */
export function markerFile(): string {
  return join(vliteHome(), 'connect-off.json');
}

/** `connect --uninstall` records what it was asked to disconnect; a plain `connect` removes the marker. */
function updateMarker(apps: ('claude' | 'codex')[], uninstall: boolean): void {
  const file = markerFile();
  if (!uninstall) {
    rmSync(file, { force: true });
    return;
  }
  let was: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObj(parsed) && Array.isArray(parsed.apps)) was = parsed.apps.filter((a): a is string => typeof a === 'string');
  } catch {
    // no marker yet, or an unreadable one: start again
  }
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, { apps: [...new Set([...was, ...apps])], time: new Date().toISOString() });
}

export function connect(opts: ConnectOpts): string[] {
  const uninstall = opts.uninstall ?? false;
  const claudeCommand = hookCommand(false);
  const codexCommand = hookCommand(true);
  const notes: string[] = [];
  if (opts.apps.includes('claude')) {
    const home = opts.claudeHome ?? join(homedir(), '.claude');
    if (!existsSync(home)) notes.push('Claude Code not found');
    else notes.push(...connectOne('Claude Code', join(home, 'settings.json'), uninstall, claudeCommand));
  }
  if (opts.apps.includes('codex')) {
    const home = opts.codexHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
    if (!existsSync(home)) notes.push('Codex not found');
    else {
      const toml = join(home, 'config.toml');
      const tomlText = existsSync(toml) ? readFileSync(toml, 'utf8') : '';
      // A hook table such as [hooks] or [[hooks.Stop]] counts. Codex itself writes
      // [hooks.state.'...'] tables to record hook trust; those are not hooks.
      const tomlHooks = /^\s*\[\[?hooks(?:\]|\.(?!state[.\]])[^\]]*\])/m.test(tomlText);
      if (uninstall) {
        // Always remove our entry from hooks.json, also when config.toml has hooks.
        notes.push(...connectOne('Codex', join(home, 'hooks.json'), true, codexCommand));
        if (tomlHooks && tomlText.includes('stop-check')) notes.push(`Codex: ${toml} may hold the VerdictLite hook too. Remove it from there by hand.`);
      } else if (tomlHooks) {
        notes.push(`Codex: ${toml} already has hooks. Codex warns when two places define hooks, so I did not write hooks.json.`);
        notes.push(`Add the VerdictLite Stop hook to ${toml} by hand. The command is:\n${codexCommand}`);
      } else {
        notes.push(...connectOne('Codex', join(home, 'hooks.json'), false, codexCommand));
        notes.push('Codex runs a new hook only after you approve it: in Codex, click Review hooks in the message box, or open Settings > Hooks.');
      }
    }
  }
  try {
    updateMarker(opts.apps, uninstall);
  } catch (e) {
    notes.push(`Could not update ${markerFile()} (${(e as Error).message}). The installer may connect again on an update.`);
  }
  return notes;
}
