import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
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
  /** HEAD commit at each pass, per key. A start point is reused only when this commit is still in HEAD's history. */
  lastPassHead?: Record<string, string>;
  /** Per branch key, per concrete part name: the tree at which all of that part's checks last passed. Missing in older state. */
  partPassTree?: Record<string, Record<string, string>>;
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

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const MAX_ROUNDS_KEYS = 500;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? '';

/** Keeps the 500 most recent round keys (insertion order). */
function capRounds(state: State): void {
  const keys = Object.keys(state.rounds);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ROUNDS_KEYS))) delete state.rounds[k];
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (!RETRY_CODES.has(errCode(e)) || attempt >= 8) throw e;
      sleepMs(20 * (attempt + 1));
    }
  }
}

function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, 'state.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      const code = errCode(e);
      if (code !== 'EEXIST' && !RETRY_CODES.has(code)) throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock); // left behind by a crashed run
      } catch {
        // gone already, or not ours to remove right now
      }
      if (Date.now() > deadline) throw new Error('could not lock state.json (another VerdictLite run holds it)');
      sleepMs(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // already removed as stale
    }
  }
}

/** Locks the state, re-reads it, applies mutate to the fresh copy, and writes it back. Returns the saved state. */
export function updateState(dir: string, mutate: (s: State) => void): State {
  return withLock(dir, () => {
    const state = readState(dir);
    mutate(state);
    capRounds(state);
    writeAtomic(join(dir, 'state.json'), JSON.stringify(state, null, 2));
    return state;
  });
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
