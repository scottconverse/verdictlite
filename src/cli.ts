#!/usr/bin/env node
import { resolve } from 'node:path';
import { ConfigError } from './config.js';
import { type Ctx, openRepo } from './context.js';
import { commitMsg, preCommit, report } from './gate.js';
import { repoRoot } from './git.js';
import { connect } from './connect.js';
import { claudeSnippet, install } from './install.js';
import { review } from './review.js';
import { readSettings, writeSettings } from './settings.js';
import { type Method, UsageError, writeStamp } from './stamp.js';
import { stopCheck } from './stopcheck.js';

const HELP = `vlite - VerdictLite: verification gates for AI coding agents

  vlite install [--repo DIR] [--claude] [--uninstall]
  vlite connect [--claude] [--codex] [--uninstall]  (add the Stop hook to the Claude Code and Codex apps; no flag = both)
  vlite stop-check [--session ID] [--global] (Claude Code Stop hook; reads hook JSON on stdin)
                                             --global: user-level hook; checks the repos the session edited
  vlite stamp <verify|code-review> --result <pass|fail> [--evidence PATH ...] [--note TEXT]
  vlite gate <pre-commit | commit-msg FILE | report [--days N]>
  vlite require-org [NAME | --remove NAME | --list]  (every repo of this GitHub org must have a vlite.json; no args = list)
  vlite review [--base REF] [--round-note TEXT]

Every command takes --repo DIR (default: the current folder).
`;

const VALUE_FLAGS = new Set(['repo', 'session', 'result', 'evidence', 'note', 'days', 'base', 'round-note', 'remove']);
const BOOL_FLAGS = new Set(['claude', 'codex', 'uninstall', 'help', 'global', 'list']);

interface Args {
  pos: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOL_FLAGS.has(name)) flags.set(name, ['true']);
    else if (VALUE_FLAGS.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, [...(flags.get(name) ?? []), v]);
    } else throw new UsageError(`unknown option --${name}`);
  }
  return { pos, flags };
}

const one = (a: Args, name: string): string | undefined => a.flags.get(name)?.at(-1);

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, sub, arg] = args.pos;
  const dir = resolve(one(args, 'repo') ?? process.cwd());
  if (!cmd || args.flags.has('help')) {
    process.stdout.write(HELP);
    return cmd || args.flags.has('help') ? 0 : 1;
  }
  if (cmd === 'stop-check') {
    const session = one(args, 'session');
    const repo = one(args, 'repo');
    return stopCheck({ ...(session ? { session } : {}), ...(repo ? { repo } : {}), global: args.flags.has('global') });
  }
  if (cmd === 'connect') {
    const c = args.flags.has('claude');
    const x = args.flags.has('codex');
    const apps: ('claude' | 'codex')[] = c || x ? [...(c ? (['claude'] as const) : []), ...(x ? (['codex'] as const) : [])] : ['claude', 'codex'];
    for (const n of connect({ apps, uninstall: args.flags.has('uninstall') })) process.stdout.write(`${n}\n`);
    return 0;
  }
  if (cmd === 'require-org') {
    const settings = readSettings();
    const remove = one(args, 'remove');
    const name = (sub ?? '').trim().toLowerCase();
    if (remove !== undefined) {
      const org = remove.trim().toLowerCase();
      if (!settings.requiredOrgs.includes(org)) throw new UsageError(`"${org}" is not in the required list`);
      writeSettings({ ...settings, requiredOrgs: settings.requiredOrgs.filter((o) => o !== org) });
      process.stdout.write(`Removed "${org}" from the required orgs.\n`);
      return 0;
    }
    if (name && !args.flags.has('list')) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new UsageError(`not a GitHub org name: ${name}`);
      if (!settings.requiredOrgs.includes(name)) writeSettings({ ...settings, requiredOrgs: [...settings.requiredOrgs, name] });
      process.stdout.write(`Every repo of the GitHub org "${name}" must now have a vlite.json.\n`);
      return 0;
    }
    process.stdout.write(settings.requiredOrgs.length > 0 ? `${settings.requiredOrgs.join('\n')}\n` : 'No required orgs.\n');
    return 0;
  }
  if (cmd === 'install') {
    const root = repoRoot(dir);
    if (!root) throw new UsageError(`not a git repo: ${dir}`);
    for (const n of install(root, args.flags.has('uninstall'))) process.stdout.write(`${n}\n`);
    if (args.flags.has('claude') && !args.flags.has('uninstall')) process.stdout.write(`\n${claudeSnippet()}\n`);
    return 0;
  }
  if (cmd === 'gate') {
    if (sub === 'report') {
      const ctx = openRepo(dir);
      if (!ctx) return 0;
      process.stdout.write(`${report(ctx, Number(one(args, 'days') ?? 7))}\n`);
      return 0;
    }
    if (sub !== 'pre-commit' && sub !== 'commit-msg') throw new UsageError('use: vlite gate <pre-commit|commit-msg FILE|report>');
    if (sub === 'commit-msg' && !arg) throw new UsageError('vlite gate commit-msg needs the message file');
    let ctx: Ctx | null;
    try {
      ctx = openRepo(dir);
    } catch (e) {
      // A broken config must not stop people from committing; say it loudly and let the commit through.
      process.stderr.write(`VerdictLite gate skipped: ${(e as Error).message}\n`);
      return 0;
    }
    if (!ctx) return 0;
    try {
      return sub === 'pre-commit' ? preCommit(ctx) : commitMsg(ctx, resolve(process.cwd(), arg as string));
    } catch (e) {
      // In observe mode the gate must never fail a commit. Enforce mode keeps its behavior.
      if (ctx.config.gate.mode !== 'enforce') {
        process.stderr.write(`VerdictLite gate error (ignored, observe mode): ${(e as Error).message}\n`);
        return 0;
      }
      throw e;
    }
  }
  if (cmd === 'stamp') {
    if (sub !== 'verify' && sub !== 'code-review') throw new UsageError('use: vlite stamp <verify|code-review> --result <pass|fail>');
    const result = one(args, 'result');
    if (result !== 'pass' && result !== 'fail') throw new UsageError('--result must be pass or fail');
    const ctx = openRepo(dir);
    if (!ctx) return 0;
    const s = writeStamp(ctx, sub as Method, result, args.flags.get('evidence') ?? [], one(args, 'note'));
    process.stdout.write(`Stamped ${s.method} ${s.result} for tree ${s.tree.slice(0, 12)}\n`);
    return 0;
  }
  if (cmd === 'review') {
    const ctx = openRepo(dir);
    if (!ctx) return 0;
    const base = one(args, 'base');
    const note = one(args, 'round-note');
    return review(ctx, { ...(base ? { base } : {}), ...(note !== undefined ? { roundNote: note } : {}) });
  }
  throw new UsageError(`unknown command: ${cmd}\n\n${HELP}`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    const known = e instanceof UsageError || e instanceof ConfigError;
    process.stderr.write(`vlite: ${known ? (e as Error).message : (e as Error).stack ?? String(e)}\n`);
    process.exitCode = 1;
  },
);
