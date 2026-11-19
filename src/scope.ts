import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { repoRoot } from './git.js';
import { readJsonl, vliteHome } from './state.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface Entry {
  type?: string;
  isMeta?: boolean;
  message?: { content?: unknown };
}

interface Item {
  type?: string;
  name?: string;
  input?: { file_path?: unknown; notebook_path?: unknown };
}

/** True for a prompt the person typed (not a tool result and not a meta line). */
function isPrompt(e: Entry): boolean {
  if (e.type !== 'user' || e.isMeta === true) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((i: Item) => i?.type === 'text') && !c.some((i: Item) => i?.type === 'tool_result');
}

/** Files the session edited with its edit tools since the last prompt the person typed. */
export function editedFiles(transcript: string, cwd: string): string[] {
  if (!existsSync(transcript)) return [];
  const entries = readJsonl<Entry>(transcript);
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPrompt(entries[i] as Entry)) {
      start = i + 1;
      break;
    }
  }
  const out = new Set<string>();
  for (const e of entries.slice(start)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const i of e.message.content as Item[]) {
      if (i?.type !== 'tool_use' || !EDIT_TOOLS.has(i.name ?? '')) continue;
      const p = i.input?.file_path ?? i.input?.notebook_path;
      if (typeof p === 'string' && p) out.add(isAbsolute(p) ? p : resolve(cwd, p));
    }
  }
  return [...out];
}

/** Git root of a file, found from its nearest folder that exists (the file may have been deleted). */
export function rootOf(file: string): string | null {
  let dir = dirname(file);
  for (let n = 0; n < 64 && !existsSync(dir); n++) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return existsSync(dir) ? repoRoot(dir) : null;
}

/** True when the repo's own .claude/settings.json already runs vlite stop-check (the project hook covers that repo). */
export function hasProjectHook(root: string): boolean {
  const f = join(root, '.claude', 'settings.json');
  try {
    return existsSync(f) && readFileSync(f, 'utf8').includes('vlite stop-check');
  } catch {
    return false;
  }
}

/** Repos a session's last block was about, kept so the next stop checks them again. */
function sessionFile(session: string): string {
  return join(vliteHome(), 'sessions', `${session.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.json`);
}

export function readSessionRoots(session: string): string[] {
  try {
    const v = JSON.parse(readFileSync(sessionFile(session), 'utf8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeSessionRoots(session: string, roots: string[]): void {
  const f = sessionFile(session);
  if (roots.length === 0) {
    rmSync(f, { force: true });
    return;
  }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(roots));
}
