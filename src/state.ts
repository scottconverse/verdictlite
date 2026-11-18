import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { commonDir } from './git.js';

export interface Pending {
  method: string;
  time: string;
}

export interface State {
  /** Last tree that passed stop-check, per branch (a tree from another branch would make a false diff). */
  lastPassTree?: Record<string, string>;
  rounds: Record<string, number>;
  pending: Record<string, Pending>;
  blocks: string[];
}

export function vliteHome(): string {
  return process.env['VLITE_HOME'] || join(homedir(), '.verdictlite');
}

/** Folder for one repo. All worktrees of a repo share it, because the id comes from the git common dir. */
export function stateDir(root: string): string {
  const common = commonDir(root);
  const key = process.platform === 'win32' ? common.toLowerCase() : common;
  const hash = createHash('sha256').update(key.replace(/\\/g, '/')).digest('hex').slice(0, 10);
  const folder = basename(common) === '.git' ? basename(dirname(common)) : basename(common).replace(/\.git$/, '');
  const name = folder.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'repo';
  const dir = join(vliteHome(), `${name}-${hash}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readState(dir: string): State {
  const file = join(dir, 'state.json');
  const empty: State = { rounds: {}, pending: {}, blocks: [] };
  if (!existsSync(file)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<State>) };
  } catch {
    return empty;
  }
}

export function writeState(dir: string, state: State): void {
  const file = join(dir, 'state.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export function appendJsonl(file: string, record: object): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a torn line; the log is append-only
    }
  }
  return out;
}
