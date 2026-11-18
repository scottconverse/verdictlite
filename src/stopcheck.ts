import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allDocs, type Ctx, openRepo } from './context.js';
import { matchAny } from './glob.js';
import { baseTree, branchName, changedFiles, diffText, isTree, repoRoot, worktreeTree } from './git.js';
import { planParts } from './parts.js';
import { lastLines, runShell } from './proc.js';
import { appendJsonl, readState, stateDir, writeState } from './state.js';
import { detectTamper, formatHits, parseDiff, RETRY_CONFIG_FILES } from './tamper.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

interface Failure {
  check: string; // "part/check"
  command: string;
  code: number | null;
  timedOut: boolean;
  output: string;
}

function readHookInput(): HookInput {
  if (process.stdin.isTTY) return {};
  try {
    const text = readFileSync(0, 'utf8').trim();
    return text ? (JSON.parse(text) as HookInput) : {};
  } catch {
    return {};
  }
}

/** The Claude Code Stop hook. Always exits 0: it speaks through JSON on stdout, and fails open on its own errors. */
export async function stopCheck(opts: { repo?: string; session?: string }): Promise<number> {
  const input = opts.session ? {} : readHookInput();
  const dir = resolve(input.cwd ?? opts.repo ?? process.cwd());
  try {
    const ctx = openRepo(dir);
    if (!ctx) return 0;
    await judge(ctx, opts.session ?? input.session_id ?? 'manual', input.stop_hook_active === true);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`VerdictLite stop-check internal error (ignored, not blocking): ${message}\n`);
    try {
      const root = repoRoot(dir);
      if (root) appendJsonl(join(stateDir(root), 'stop.jsonl'), { result: 'error', error: message });
    } catch {
      // nothing more we can do
    }
  }
  return 0;
}

async function judge(ctx: Ctx, session: string, hookActive: boolean): Promise<void> {
  const { root, config } = ctx;
  const tree = worktreeTree(root);
  const state = readState(ctx.stateDir);
  const branch = branchName(root);
  const last = state.lastPassTree?.[branch];
  if (last === tree) return;

  const from = last && isTree(root, last) ? last : baseTree(root, ctx.base);
  const changed = changedFiles(root, from, tree);
  const base = { session, tree, branch, from, changed: changed.length, hookActive };

  const pass = (extra: object): void => {
    state.lastPassTree = { ...state.lastPassTree, [branch]: tree };
    for (const k of Object.keys(state.rounds)) if (k.startsWith(`${session}|`)) delete state.rounds[k];
    writeState(ctx.stateDir, state);
    ctx.log('stop', { ...base, result: 'pass', ...extra });
  };

  if (changed.length === 0 || allDocs(config, changed)) {
    pass({ docsOnly: true });
    return;
  }

  const failures: Failure[] = [];
  const tamperFiles = [...config.tests.paths, ...RETRY_CONFIG_FILES];
  if (changed.some((f) => matchAny(tamperFiles, f))) {
    const hits = detectTamper(parseDiff(diffText(root, from, tree, 0)), config.tests.paths, config.tests.removalsLog);
    if (hits.length > 0) failures.push({ check: 'test-tamper', command: '(built-in)', code: 1, timedOut: false, output: formatHits(hits) });
  }

  const ran: string[] = [];
  const skipped: Record<string, string> = {};
  const plan = planParts(config.parts, changed, config.maxExpandedParts);
  for (const t of plan.tooMany) {
    const output = [
      `${t.names.length} modules changed for the template part "${t.template}"; the limit is ${config.maxExpandedParts} (maxExpandedParts).`,
      `None of these parts ran: ${t.names.join(', ')}`,
      'Run the wider check by hand, or raise maxExpandedParts on the base branch.',
    ].join('\n');
    failures.push({ check: `${t.template} (too many parts)`, command: '(built-in)', code: 1, timedOut: false, output });
  }
  for (const part of plan.parts) {
    const missing = part.requires.filter((p) => !existsSync(resolve(root, p)));
    if (missing.length > 0) {
      skipped[part.name] = `requires missing: ${missing.join(', ')}`;
      continue;
    }
    for (const check of part.checks) {
      const name = `${part.name}/${check.name}`;
      ran.push(name);
      const r = await runShell(check.run, resolve(root, check.cwd), check.timeoutSec);
      if (r.code === 0 && !r.timedOut) continue;
      failures.push({ check: name, command: check.run, code: r.code, timedOut: r.timedOut, output: r.output });
      break; // first failing check per part; other parts still run
    }
  }

  const extra = Object.keys(skipped).length > 0 ? { skipped } : {};
  if (failures.length === 0) {
    pass({ ran, ...extra });
    return;
  }

  const key = `${session}|${failures.map((f) => f.check).sort().join(',')}`;
  const round = (state.rounds[key] ?? 0) + 1;
  state.rounds[key] = round;
  writeState(ctx.stateDir, state);
  const logPath = writeLogs(ctx, failures, changed, round);
  const names = failures.map((f) => f.check);

  if (round < config.maxRounds) {
    const reason = [
      'VerdictLite: checks failed on this change.',
      ...failures.map(describe),
      `Full output: ${logPath}`,
      `Round ${round} of ${config.maxRounds}. Fix the cause. Do not skip, sleep or rerun to pass.`,
    ].join('\n\n');
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
    ctx.log('stop', { ...base, result: 'block', round, failing: names, ran, ...extra, log: logPath });
    return;
  }
  const first = failures[0] as Failure;
  const why = first.timedOut ? 'it timed out' : `exit code ${String(first.code)}`;
  const stopReason = `VerdictLite: ${names.join(', ')} still fails after ${round} rounds. A person must look. Last failure: ${why}. Handoff: ${logPath}`;
  process.stdout.write(`${JSON.stringify({ continue: false, stopReason })}\n`);
  ctx.log('stop', { ...base, result: 'handoff', round, failing: names, ran, ...extra, handoff: logPath });
}

function describe(f: Failure): string {
  const status = f.timedOut ? 'timed out' : `exit code ${String(f.code)}`;
  return `[${f.check}] failed\ncommand: ${f.command}\n${status}\nlast lines of output:\n${lastLines(f.output, 60)}`;
}

/** Writes the full output (the handoff file a person reads) and returns its path. */
function writeLogs(ctx: Ctx, failures: Failure[], changed: string[], round: number): string {
  const dir = join(ctx.stateDir, 'handoffs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}-round${round}.txt`);
  const body = [
    `VerdictLite handoff, round ${round} of ${ctx.config.maxRounds}`,
    `Repo: ${ctx.root}`,
    `Changed files (${changed.length}):\n${changed.slice(0, 200).join('\n')}`,
    ...failures.map((f) => `===== ${f.check} =====\ncommand: ${f.command}\nexit code: ${String(f.code)}${f.timedOut ? ' (timed out)' : ''}\n\n${lastLines(f.output, 2000)}`),
  ].join('\n\n');
  writeFileSync(path, `${body}\n`);
  return path;
}
