import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { FILES_TOKEN as FILES, type Part } from './config.js';
import { allDocs, type Ctx, isDocs, openRepo } from './context.js';
import { matchAny } from './glob.js';
import { baseTree, changedFiles, diffText, existsAt, git, headSha, isAncestorOfHead, isTree, repoRoot, stateKey, worktreeTree } from './git.js';
import { planParts } from './parts.js';
import { lastLines, quoteArg, runShell } from './proc.js';
import { editedFiles, hasProjectHook, readSessionRoots, rootOf, writeSessionRoots } from './scope.js';
import { originOwner, readSettings } from './settings.js';
import { writeStamp } from './stamp.js';
import { appendJsonl, readState, stateDir, type State, updateState } from './state.js';
import { detectTamper, formatHits, parseDiff, RETRY_CONFIG_FILES } from './tamper.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

/** What judge decided for one repo. */
type Verdict = { kind: 'pass' } | { kind: 'block'; reason: string } | { kind: 'handoff'; stopReason: string } | { kind: 'warn'; message: string };

interface Failure {
  check: string; // "part/check"
  command: string;
  code: number | null;
  output: string;
  /** Set when only the changed test files were run instead of the whole check. */
  narrow?: { files: string[]; deleted: string[]; since: string };
}

/** How one part will run: its changed test files since the part last passed, or the reason it runs in full. */
interface NarrowPlan {
  files: string[]; // changed test files that still exist
  deleted: string[]; // changed test files that are gone
  since: string; // the tree at which the part last passed
}


/**
 * Narrow mode for one concrete part: only when the part passed before (tree P), and since P only test files and docs
 * changed in the part's paths, with at least one test file. Every changed file under tests.paths must be a real test
 * file (tests.files); a helper, fixture or conftest.py forces the full check. Returns null (run as today) otherwise, and a note when
 * the person should be told why the narrow form was not used.
 */
function planNarrow(ctx: Ctx, part: Part, since: string | undefined, tree: string): { plan: NarrowPlan | null; note?: string } {
  const { root, config } = ctx;
  if (!since || since === tree || !isTree(root, since)) return { plan: null };
  const inPart = changedFiles(root, since, tree).filter((f) => matchAny(part.paths, f));
  const tests = inPart.filter((f) => matchAny(config.tests.paths, f));
  if (tests.length === 0) return { plan: null };
  if (tests.some((f) => !matchAny(config.tests.files, f))) return { plan: null };
  if (inPart.some((f) => !matchAny(config.tests.paths, f) && !isDocs(config, f))) return { plan: null };
  const files = tests.filter((f) => existsSync(resolve(root, f)));
  const deleted = tests.filter((f) => !existsSync(resolve(root, f)));
  if (files.length === 0) return { plan: null, note: `VerdictLite: ${part.name}: every changed test file was deleted (${deleted.join(', ')}), so the part ran in full.` };
  return { plan: { files, deleted, since } };
}

/** The check's runFiles with {files} replaced by the quoted test files, as paths from the check's folder. */
function narrowCommand(root: string, cwd: string, runFiles: string, files: string[]): string {
  const base = resolve(root, cwd);
  const args = files.map((f) => quoteArg(relative(base, resolve(root, f)).replace(/\\/g, '/')));
  return runFiles.split(FILES).join(args.join(' '));
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

/**
 * The Claude Code Stop hook. Always exits 0: it speaks through JSON on stdout, and fails open on its own errors.
 * Default: checks the repo of the session folder. With global (a user-level hook), it checks every repo with a
 * vlite.json that the session edited this turn, plus the session folder's repo when that repo has no project hook.
 */
export async function stopCheck(opts: { repo?: string; session?: string; global?: boolean }): Promise<number> {
  // A review session (started by `vlite review`) must never run checks or be blocked.
  if (process.env['VLITE_REVIEWER'] === '1') return 0;
  const input = opts.session ? {} : readHookInput();
  const dir = resolve(opts.repo ?? input.cwd ?? process.cwd());
  const session = opts.session ?? input.session_id ?? 'manual';
  const hookActive = input.stop_hook_active === true;
  if (!opts.global) {
    const v = await judgeDir(dir, session, hookActive);
    emit(v ? [v] : []);
    return 0;
  }
  const own = safeRoot(dir);
  const covered = own !== null && hasProjectHook(own);
  const roots = new Set<string>(readSessionRoots(session));
  if (own && !covered) roots.add(own);
  if (input.transcript_path) {
    try {
      for (const f of editedFiles(input.transcript_path, dir)) {
        const r = rootOf(f);
        if (r) roots.add(r);
      }
    } catch (e) {
      process.stderr.write(`VerdictLite: could not read the transcript (ignored): ${(e as Error).message}\n`);
    }
  }
  // The project hook already checks the session folder's repo; do not run it twice.
  if (own && covered) roots.delete(own);
  const verdicts: Verdict[] = [];
  const stillFailing: string[] = [];
  for (const root of roots) {
    const v = await judgeDir(root, session, hookActive);
    if (!v) continue;
    verdicts.push(v);
    if (v.kind === 'block') stillFailing.push(root);
  }
  try {
    writeSessionRoots(session, stillFailing);
  } catch {
    // losing this list only means the next stop may not re-check that repo
  }
  emit(verdicts);
  return 0;
}

function safeRoot(dir: string): string | null {
  try {
    return repoRoot(dir);
  } catch {
    return null;
  }
}

/** Runs judge for one folder. Null when it is not a vlite repo. On an internal or config error it fails open with a warning that the person sees. */
async function judgeDir(dir: string, session: string, hookActive: boolean): Promise<Verdict | null> {
  try {
    const ctx = openRepo(dir);
    if (!ctx) return missingConfig(dir, hookActive);
    return await judge(ctx, session, hookActive);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`VerdictLite stop-check internal error (ignored, not blocking): ${message}\n`);
    try {
      const root = repoRoot(dir);
      if (root) appendJsonl(join(stateDir(root), 'stop.jsonl'), { result: 'error', error: message });
    } catch {
      // nothing more we can do
    }
    return { kind: 'warn', message: `VerdictLite could not check ${dir}: ${message}. Checks did NOT run.` };
  }
}

/** A repo with no vlite.json: when its GitHub org is required, block once and tell the agent to add one. */
function missingConfig(dir: string, hookActive: boolean): Verdict | null {
  const root = repoRoot(dir);
  if (!root) return null;
  const owner = originOwner(root);
  if (!owner || !readSettings().requiredOrgs.includes(owner)) return null;
  try {
    appendJsonl(join(stateDir(root), 'stop.jsonl'), { result: 'missing-config', org: owner, hookActive });
  } catch {
    // the log is a convenience; never lose the verdict over it
  }
  if (hookActive) return { kind: 'warn', message: `VerdictLite: this repo (${root}) belongs to the required GitHub org "${owner}" and still has no vlite.json.` };
  return {
    kind: 'block',
    reason: `VerdictLite: this repo (${root}) belongs to the GitHub org "${owner}", and every repo there must be guarded by VerdictLite. It has no vlite.json yet. Write vlite.json at the repo root with the checks this repo needs (lint, tests, build), run them once to prove they pass, then run "vlite install" in the repo and commit vlite.json to the default branch. Guide: https://github.com/scottconverse/verdictlite/blob/main/docs/manual.md#3-set-up-a-repo . A docs-only repo can use {"version": 1, "parts": []}.`,
  };
}

/** One JSON line for Claude Code. A handoff wins over a block. Passes print nothing. Warnings ride along, or print alone. */
function emit(verdicts: Verdict[]): void {
  const stops: string[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  for (const v of verdicts) {
    if (v.kind === 'handoff') stops.push(v.stopReason);
    else if (v.kind === 'block') reasons.push(v.reason);
    else if (v.kind === 'warn') warnings.push(v.message);
  }
  const warn = warnings.join('\n');
  const out = (o: object): void => void process.stdout.write(`${JSON.stringify(o)}
`);
  if (stops.length > 0) out({ continue: false, stopReason: [...stops, ...warnings].join('\n') });
  else if (reasons.length > 0) out({ decision: 'block', reason: [reasons.join('\n\n'), ...(warn ? [warn] : [])].join('\n\n') });
  else if (warn) out({ systemMessage: warn });
}

/** Saves a state change. A failed save is reported on stderr and never drops a block or a pass. */
function saveState(dir: string, mutate: (s: State) => void): boolean {
  try {
    updateState(dir, mutate);
    return true;
  } catch (e) {
    process.stderr.write(`VerdictLite: could not save state (ignored): ${(e as Error).message}\n`);
    return false;
  }
}

async function judge(ctx: Ctx, session: string, hookActive: boolean): Promise<Verdict> {
  const { root, config } = ctx;
  const tree = worktreeTree(root);
  const state = readState(ctx.stateDir);
  const branch = stateKey(root);
  const last = state.lastPassTree?.[branch];
  if (last === tree) return { kind: 'pass' };

  // A saved pass is a start point only if it still belongs to this line of work: no pass head saved (older state),
  // HEAD unchanged, or HEAD is a descendant whose tree is exactly the passed tree (the passed work was committed).
  const head = headSha(root);
  const savedHead = state.lastPassHead?.[branch];
  let usable = !!last && isTree(root, last);
  if (usable && savedHead && savedHead !== head) {
    usable = isAncestorOfHead(root, savedHead) && head !== null && commitTree(root, head) === last;
  }
  const from = usable && last ? last : baseTree(root, ctx.base);
  const changed = changedFiles(root, from, tree);
  const base = { session, tree, branch, from, changed: changed.length, hookActive };

  const pass = (extra: object): void => {
    saveState(ctx.stateDir, (s) => {
      s.lastPassTree = { ...s.lastPassTree, [branch]: tree };
      if (head) s.lastPassHead = { ...s.lastPassHead, [branch]: head };
      // This session's rounds on this branch, and its old-format keys (one key per set of failing checks).
      for (const k of Object.keys(s.rounds)) if (k === roundKey(session, branch) || (k.startsWith(`${session}|`) && !k.startsWith(`${session}|branch:`))) delete s.rounds[k];
    });
    ctx.log('stop', { ...base, result: 'pass', ...extra });
    // A pass on this exact tree counts as proof at commit, but only when a check really ran and no part was skipped.
    // A failed stamp write never turns a pass into an error.
    const e = extra as { ran?: string[]; skipped?: object; narrow?: object };
    if (!e.ran || e.ran.length === 0 || e.skipped) return;
    try {
      writeStamp(ctx, 'stop-check', 'pass', [], e.narrow ? 'stop-check pass (narrow: only changed test files ran)' : 'stop-check pass', tree);
    } catch (e) {
      process.stderr.write(`VerdictLite: could not write stop-check stamp (ignored): ${(e as Error).message}
`);
    }
  };

  if (changed.length === 0 || allDocs(config, changed)) {
    pass({ docsOnly: true });
    return { kind: 'pass' };
  }

  const failures: Failure[] = [];
  const tamperFiles = [...config.tests.paths, ...RETRY_CONFIG_FILES];
  if (changed.some((f) => matchAny(tamperFiles, f))) {
    const hits = detectTamper(parseDiff(diffText(root, from, tree, 0)), config.tests.paths, config.tests.removalsLog);
    if (hits.length > 0) failures.push({ check: 'test-tamper', command: '(built-in)', code: 1, output: formatHits(hits) });
  }

  const ran: string[] = [];
  const skipped: Record<string, string> = {};
  const narrowRuns: Record<string, string[]> = {};
  const deletedFiles: string[] = [];
  const notes: string[] = [];
  const passedParts: string[] = [];
  const timeouts: { check: string; seconds: number }[] = [];
  const plan = planParts(config.parts, changed, config.maxExpandedParts);
  // Too many modules for a template is not a failure (the agent cannot fix it): its parts do not run, and the person is told.
  const tooManyMessage = (t: { template: string; names: string[] }, otherPassed: boolean): string =>
    `VerdictLite: ${t.names.length} modules changed for "${t.template}" (limit ${config.maxExpandedParts}), so their module checks did not run: ${t.names.join(', ')}. ${otherPassed ? 'Other checks passed. ' : ''}Run the wider tests by hand, or raise maxExpandedParts on the base branch.`;
  for (const t of plan.tooMany) skipped[t.template] = `too many modules (${t.names.length}, limit ${config.maxExpandedParts}): ${t.names.join(', ')}`;
  for (const part of plan.parts) {
    const missing = part.requires.filter((p) => !existsSync(resolve(root, p)));
    if (missing.length > 0) {
      // A path that the base branch has but the change removed is a failure: deleting it must not skip the checks.
      const deleted = ctx.base ? missing.filter((p) => existsAt(root, ctx.base as string, p)) : [];
      if (deleted.length > 0) {
        failures.push({
          check: `${part.name}/requires`,
          command: '(built-in)',
          code: 1,
          output: `The change deleted a required path: ${deleted.join(', ')}. The base branch (${ctx.base}) has it, and the checks of part "${part.name}" need it. Restore it; do not delete a path to skip checks.`,
        });
        continue;
      }
      skipped[part.name] = `requires missing: ${missing.join(', ')}`;
      notes.push(`VerdictLite: part "${part.name}" was skipped, so its checks did NOT run: required path missing (${missing.join(', ')}) and not on the base branch either.`);
      continue;
    }
    const { plan: narrow, note } = planNarrow(ctx, part, state.partPassTree?.[branch]?.[part.name], tree);
    if (note) notes.push(note);
    if (narrow && narrow.deleted.length > 0) deletedFiles.push(...narrow.deleted.map((d) => `${d} (deleted, not run)`));
    let allPassed = true;
    for (const check of part.checks) {
      const name = `${part.name}/${check.name}`;
      ran.push(name);
      let command = check.run;
      let used: Failure['narrow'];
      if (narrow && check.runFiles) {
        command = narrowCommand(root, check.cwd, check.runFiles, narrow.files);
        used = { files: narrow.files, deleted: narrow.deleted, since: narrow.since };
        narrowRuns[name] = narrow.files;
      } else if (narrow) {
        notes.push(`VerdictLite: ${name} has no "runFiles", so it ran in full.`);
      }
      const r = await runShell(command, resolve(root, check.cwd), check.timeoutSec);
      if (r.code === 0 && !r.timedOut) continue;
      allPassed = false;
      // A frozen check says nothing about the code: it is no result, not a failure. The part is not marked passed.
      if (r.timedOut) timeouts.push({ check: name, seconds: check.timeoutSec });
      else failures.push({ check: name, command, code: r.code, output: r.output, ...(used ? { narrow: used } : {}) });
      break; // first failing check per part; other parts still run
    }
    if (allPassed) passedParts.push(part.name);
  }
  // A part that passed is remembered even when another part failed in this run.
  if (passedParts.length > 0) {
    saveState(ctx.stateDir, (s) => {
      s.partPassTree = { ...s.partPassTree, [branch]: { ...s.partPassTree?.[branch], ...Object.fromEntries(passedParts.map((p) => [p, tree])) } };
    });
  }

  const extra = {
    ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
    ...(Object.keys(narrowRuns).length > 0 ? { narrow: narrowRuns, deleted: deletedFiles } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
  // What ran narrow or in full, one line each, so the person sees it.
  const info = [
    ...Object.entries(narrowRuns).map(([n, files]) => `VerdictLite: ${n} ran only the changed test files (${files.join(', ')}), because product code is unchanged since the last pass of its part.`),
    ...deletedFiles.map((d) => `VerdictLite: ${d}`),
    ...notes,
  ];
  const timeoutWarnings = timeouts.map((t) => `VerdictLite: ${t.check} froze: no answer after ${t.seconds} s, so it was stopped. The result is unknown; it is not a failure and not a pass. You can continue.`);
  if (failures.length === 0 && timeouts.length > 0) {
    ctx.log('stop', { ...base, result: 'no-result', ran, timedOut: timeouts.map((t) => t.check), ...extra });
    return { kind: 'warn', message: [...timeoutWarnings, ...plan.tooMany.map((t) => tooManyMessage(t, true)), ...info].join('\n') };
  }
  if (failures.length === 0) {
    pass({ ran, ...extra });
    const lines = [...plan.tooMany.map((t) => tooManyMessage(t, true)), ...info];
    if (lines.length > 0) return { kind: 'warn', message: lines.join('\n') };
    return { kind: 'pass' };
  }

  // Rounds count per session and branch, not per set of failing checks, so failures that take turns still reach maxRounds.
  const key = roundKey(session, branch);
  let round = (state.rounds[key] ?? 0) + 1;
  const saved = saveState(ctx.stateDir, (s) => {
    round = (s.rounds[key] ?? 0) + 1;
    delete s.rounds[key]; // re-added last, so the cap keeps the most recent keys
    // A handoff ends this run of rounds: after a person says "keep going", the next stop starts at round 1.
    if (round < config.maxRounds) s.rounds[key] = round;
  });
  if (!saved) round = (state.rounds[key] ?? 0) + 1; // save failed: still decide from what was read, never drop the block
  const logPath = writeLogs(ctx, failures, changed, round);
  const names = failures.map((f) => f.check);

  if (round < config.maxRounds) {
    const reason = [
      `VerdictLite: checks failed on this change (repo ${root}).`,
      ...failures.map(describe),
      `Full output: ${logPath}`,
      `Round ${round} of ${config.maxRounds}. Fix the cause. Do not skip, sleep or rerun to pass.`,
      ...plan.tooMany.map((t) => tooManyMessage(t, false)),
      ...(info.length > 0 ? [info.join('\n')] : []),
      ...timeoutWarnings,
    ].join('\n\n');
    ctx.log('stop', { ...base, result: 'block', round, failing: names, ran, ...extra, log: logPath });
    return { kind: 'block', reason };
  }
  const first = failures[0] as Failure;
  const why = `exit code ${String(first.code)}`;
  const stopReason = `VerdictLite: ${names.join(', ')} still fails after ${round} rounds. A person must look. Last failure: ${why}. Handoff: ${logPath}${timeoutWarnings.length > 0 ? `\n${timeoutWarnings.join('\n')}` : ''}`;
  ctx.log('stop', { ...base, result: 'handoff', round, failing: names, ran, ...extra, handoff: logPath });
  return { kind: 'handoff', stopReason };
}

/** State key for the rounds of one session on one branch. Older state used the failing checks here; those keys are ignored and cleared on a pass. */
function roundKey(session: string, branch: string): string {
  return `${session}|branch:${branch}`;
}

/** Tree of a commit. */
function commitTree(root: string, head: string): string | null {
  const r = git(root, ['rev-parse', `${head}^{tree}`]);
  return r.ok ? r.out.trim() : null;
}

function describe(f: Failure): string {
  const status = `exit code ${String(f.code)}`;
  const narrow = f.narrow
    ? `\nOnly these test files ran: ${f.narrow.files.join(', ')}.${f.narrow.deleted.length > 0 ? ` Deleted, not run: ${f.narrow.deleted.join(', ')}.` : ''} The rest of the part's tests were skipped because product code is unchanged since the last pass of this part (tree ${f.narrow.since.slice(0, 8)}).`
    : '';
  return `[${f.check}] failed\ncommand: ${f.command}\n${status}${narrow}\nlast lines of output:\n${lastLines(f.output, 60)}`;
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
    ...failures.map((f) => `===== ${f.check} =====\ncommand: ${f.command}\nexit code: ${String(f.code)}\n\n${lastLines(f.output, 2000)}`),
  ].join('\n\n');
  writeFileSync(path, `${body}\n`);
  return path;
}
