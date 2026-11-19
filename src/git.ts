import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: opts.env ?? process.env,
    input: opts.input ?? '',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

export function gitOut(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  const r = git(cwd, args, opts);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.err.trim()}`);
  return r.out.trim();
}

/** Top folder of the work tree, or null when dir is not in a git repo. */
export function repoRoot(dir: string): string | null {
  try {
    const r = git(dir, ['rev-parse', '--show-toplevel']);
    return r.ok ? resolve(r.out.trim()) : null;
  } catch {
    return null;
  }
}

export function commonDir(root: string): string {
  return resolve(root, gitOut(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

export function headSha(root: string): string | null {
  const r = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.ok ? r.out.trim() : null;
}

export function refExists(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).ok;
}

export function isTree(root: string, id: string): boolean {
  return git(root, ['cat-file', '-e', `${id}^{tree}`]).ok;
}

/** File text at ref, or null when the ref or the file is missing. */
export function showFile(root: string, ref: string, path: string): string | null {
  const r = git(root, ['show', `${ref}:${path}`]);
  return r.ok ? r.out : null;
}

export function emptyTree(root: string): string {
  return gitOut(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
}

/** Tree of merge-base(base, HEAD); empty tree when there is no base or no HEAD. */
export function baseTree(root: string, base: string | null): string {
  if (base && headSha(root)) {
    const mb = git(root, ['merge-base', base, 'HEAD']);
    if (mb.ok) return gitOut(root, ['rev-parse', `${mb.out.trim()}^{tree}`]);
  }
  return emptyTree(root);
}

/** Tree id of the full working tree (tracked + untracked, .gitignore respected). Never touches the real index. */
export function worktreeTree(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vlite-idx-'));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    if (headSha(root)) gitOut(root, ['read-tree', 'HEAD'], { env });
    else gitOut(root, ['read-tree', '--empty'], { env });
    gitOut(root, ['add', '-A'], { env });
    return gitOut(root, ['write-tree'], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Tree of the index git is committing (inside a hook git sets GIT_INDEX_FILE for us). */
export function indexTree(root: string): string {
  return gitOut(root, ['write-tree']);
}

export function changedFiles(root: string, from: string, to: string): string[] {
  const out = git(root, ['diff', '--name-only', '-z', '--no-renames', from, to]);
  if (!out.ok) throw new Error(`git diff failed: ${out.err.trim()}`);
  return out.out.split('\0').filter((s) => s.length > 0);
}

export function diffText(root: string, from: string, to: string, context: number): string {
  return gitOut(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', `-U${context}`, from, to]);
}

export function branchName(root: string): string {
  const r = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = r.ok ? r.out.trim() : 'HEAD';
  return name === 'HEAD' ? 'detached' : name;
}

/**
 * Key for per-branch state. A detached HEAD is keyed by its worktree folder: many worktrees can be detached at once
 * and must not share one start point, and a key with the commit in it would reset after every commit.
 */
export function stateKey(root: string): string {
  const name = branchName(root);
  if (name !== 'detached') return name;
  const folder = (process.platform === 'win32' ? root.toLowerCase() : root).replace(/\\/g, '/');
  return `detached:${folder}`;
}

/** True when ancestor is HEAD or in HEAD's history. */
export function isAncestorOfHead(root: string, ancestor: string): boolean {
  return git(root, ['merge-base', '--is-ancestor', ancestor, 'HEAD']).ok;
}
