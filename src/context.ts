import { join } from 'node:path';
import { type Config, loadConfig } from './config.js';
import { matchAny } from './glob.js';
import { refExists, repoRoot } from './git.js';
import { appendJsonl, stateDir } from './state.js';

export interface Ctx {
  root: string;
  config: Config;
  configSource: 'base' | 'worktree';
  stateDir: string;
  /** The base ref that exists, or null in a repo without one. */
  base: string | null;
  log(file: 'stamps' | 'gate' | 'stop', record: object): void;
}

/** Null when dir is not a git repo or the repo has no vlite.json: the tool then stays quiet. Throws ConfigError on a bad config. */
export function openRepo(dir: string): Ctx | null {
  const root = repoRoot(dir);
  if (!root) return null;
  const loaded = loadConfig(root);
  if (!loaded) return null;
  if (loaded.source === 'worktree') {
    process.stderr.write('VerdictLite: vlite.json is not on the base branch yet; using the working-tree copy (bootstrap).\n');
  }
  const sdir = stateDir(root);
  const extra = loaded.source === 'worktree' ? { configSource: 'worktree' } : {};
  return {
    root,
    config: loaded.config,
    configSource: loaded.source,
    stateDir: sdir,
    base: resolveBase(root, loaded.config.base),
    log(file, record) {
      appendJsonl(join(sdir, `${file}.jsonl`), { ...record, ...extra });
    },
  };
}

export function resolveBase(root: string, preferred: string): string | null {
  for (const ref of [preferred, 'origin/main', 'main']) if (refExists(root, ref)) return ref;
  return null;
}

export function isDocs(config: Config, path: string): boolean {
  return matchAny(config.docs, path) && !matchAny(config.codeDespiteDocs, path);
}

export function allDocs(config: Config, files: string[]): boolean {
  return files.length > 0 && files.every((f) => isDocs(config, f));
}
