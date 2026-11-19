import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allDocs, type Ctx } from './context.js';
import { changedFiles, emptyTree, git, gitOut, headSha, indexTree } from './git.js';
import { passedMethods, type StampRecord } from './stamp.js';
import { readJsonl, readState, type State, updateState } from './state.js';

const ESCAPE_WINDOW_MS = 30 * 60 * 1000;

/** Saves a state change. A failure to save is reported on stderr and never changes the gate's decision. */
function saveState(ctx: Ctx, mutate: (s: State) => void): void {
  try {
    updateState(ctx.stateDir, mutate);
  } catch (e) {
    process.stderr.write(`VerdictLite: could not save state (ignored): ${(e as Error).message}\n`);
  }
}

/** How the staged tree was checked: verify, code-review, stop-check (any mix joined by +), docs, or none. */
export function methodFor(ctx: Ctx, tree: string): string {
  const head = headSha(ctx.root);
  const from = head ? gitOut(ctx.root, ['rev-parse', `${head}^{tree}`]) : emptyTree(ctx.root);
  if (allDocs(ctx.config, changedFiles(ctx.root, from, tree))) return 'docs';
  const passed = passedMethods(ctx, tree);
  return passed.length > 0 ? passed.join('+') : 'none';
}

/** pre-commit only records; the block decision waits for commit-msg, where a Verify-Skip trailer can be seen. */
export function preCommit(ctx: Ctx): number {
  const mode = ctx.config.gate.mode;
  if (mode === 'off') return 0;
  const tree = indexTree(ctx.root);
  const method = methodFor(ctx, tree);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  saveState(ctx, (state) => {
    for (const [k, p] of Object.entries(state.pending)) if (Date.parse(p.time) < dayAgo) delete state.pending[k];
    state.pending[tree] = { method, time: new Date().toISOString() };
  });
  if (mode === 'observe') ctx.log('gate', { hook: 'pre-commit', mode, tree, method, wouldBlock: method === 'none' });
  return 0;
}

export function commitMsg(ctx: Ctx, file: string): number {
  const mode = ctx.config.gate.mode;
  if (mode === 'off') return 0;
  const tree = indexTree(ctx.root);
  const state = readState(ctx.stateDir);
  let method = state.pending[tree]?.method ?? methodFor(ctx, tree);
  const trailers = git(ctx.root, ['interpret-trailers', '--parse'], { input: readFileSync(file, 'utf8') }).out;
  const skipReason = /^Verify-Skip:[ \t]*(.*\S)/im.exec(trailers)?.[1];
  if (skipReason) method = 'skipped';
  const record = { hook: 'commit-msg', mode, tree, method, ...(skipReason ? { skipReason } : {}) };

  let escape = false;
  if (mode === 'enforce' && method === 'none') {
    let blocked = false;
    const decide = (s: State): void => {
      escape = false;
      blocked = false;
      const now = Date.now();
      const recent = s.blocks.filter((t) => now - Date.parse(t) < ESCAPE_WINDOW_MS);
      if (recent.length >= 2) {
        escape = true; // two blocks in 30 minutes: let the third through and say so in the log
        s.blocks = [];
      } else {
        s.blocks = [...recent, new Date(now).toISOString()];
        blocked = true;
      }
    };
    try {
      updateState(ctx.stateDir, decide);
    } catch (e) {
      process.stderr.write(`VerdictLite: could not save state (ignored): ${(e as Error).message}\n`);
      decide(state); // the decision still stands when the save fails
    }
    if (blocked) {
      ctx.log('gate', { ...record, blocked: true });
      process.stderr.write(blockMessage());
      return 1;
    }
  }

  gitOut(ctx.root, ['interpret-trailers', '--in-place', '--if-exists', 'replace', '--trailer', `Verified-By: ${method}`, file]);
  saveState(ctx, (s) => {
    delete s.pending[tree];
  });
  ctx.log('gate', { ...record, wouldBlock: mode === 'observe' && method === 'none', ...(escape ? { escape: true } : {}) });
  return 0;
}

function blockMessage(): string {
  return [
    'VerdictLite: commit blocked. Nothing shows this exact change was verified (method: none).',
    'Do one of these, then commit again:',
    '  1. Run the checks, then:  vlite stamp verify --result pass --evidence <log file>',
    '  2. Get the AI review:     vlite review',
    '  3. Skip on purpose: add this line at the end of the commit message:',
    '       Verify-Skip: <why this commit does not need it>',
    'A stamp only counts for the exact staged tree. Stage everything first (git add -A).',
    '',
  ].join('\n');
}

interface GateRecord {
  time: string;
  hook: string;
  method: string;
  tree?: string;
  wouldBlock?: boolean;
  blocked?: boolean;
  escape?: boolean;
  skipReason?: string;
}

/** Commits stamped "none" whose exact tree got a passing stamp (any method) after the commit. The latest stamp per tree and method counts. */
function checkedAfterCommit(ctx: Ctx, commits: GateRecord[]): number {
  const latest = new Map<string, StampRecord>();
  for (const s of readJsonl<StampRecord>(join(ctx.stateDir, 'stamps.jsonl'))) latest.set(`${s.tree}|${s.method}`, s);
  const passes = [...latest.values()].filter((s) => s.result === 'pass');
  return commits.filter((c) => c.method === 'none' && c.tree !== undefined && passes.some((s) => s.tree === c.tree && Date.parse(s.time) > Date.parse(c.time))).length;
}

export function report(ctx: Ctx, days: number): string {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const recs = readJsonl<GateRecord>(join(ctx.stateDir, 'gate.jsonl')).filter((r) => r.hook === 'commit-msg' && Date.parse(r.time) >= since);
  const commits = recs.filter((r) => !r.blocked);
  const counts = new Map<string, number>();
  for (const r of commits) counts.set(r.method, (counts.get(r.method) ?? 0) + 1);
  const lines = [`VerdictLite gate report, last ${days} days (mode now: ${ctx.config.gate.mode})`, `Commits judged: ${commits.length}`];
  for (const [m, n] of [...counts].sort((a, b) => b[1] - a[1])) lines.push(`  ${m}: ${n}`);
  lines.push(`Would have been blocked (observe): ${commits.filter((r) => r.wouldBlock).length}`);
  lines.push(`Checked after commit (same files passed later): ${checkedAfterCommit(ctx, commits)}`);
  lines.push(`Blocked (enforce): ${recs.filter((r) => r.blocked).length}`);
  lines.push(`Let through after two blocks (escape): ${commits.filter((r) => r.escape).length}`);
  const skips = commits.filter((r) => r.skipReason);
  lines.push(`Overrides (Verify-Skip): ${skips.length}`);
  for (const r of skips) lines.push(`  ${r.time.slice(0, 16).replace('T', ' ')}  ${r.skipReason ?? ''}`);
  return lines.join('\n');
}
