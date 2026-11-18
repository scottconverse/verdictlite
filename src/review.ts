import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.js';
import { baseTree, branchName, diffText, refExists, showFile, worktreeTree } from './git.js';
import { quoteArg, runShell } from './proc.js';
import { UsageError, writeStamp } from './stamp.js';

const MAX_DIFF = 200 * 1024;
const SEVERITIES = ['important', 'nit', 'pre-existing'] as const;

export interface Finding {
  severity: (typeof SEVERITIES)[number];
  file: string;
  line: number;
  rule: string;
  problem: string;
  evidence: string;
}

interface Round {
  round: number;
  time: string;
  tree: string;
  base: string | null;
  rulesSource: 'base' | 'missing';
  diffTruncated: boolean;
  note?: string;
  findings: Finding[];
  rulesChecked: string[];
  fixedFromPrior: Finding[];
  error?: string;
  raw?: string;
}

export async function review(ctx: Ctx, opts: { base?: string; roundNote?: string }): Promise<number> {
  const { root, config } = ctx;
  if (opts.base && !refExists(root, opts.base)) throw new UsageError(`base ref not found: ${opts.base}`);
  const base = opts.base ?? ctx.base;
  const rules = base ? showFile(root, base, config.review.rulesFile) : null;
  const tree = worktreeTree(root);
  let diff = diffText(root, baseTree(root, base), tree, 3);
  const diffTruncated = Buffer.byteLength(diff) > MAX_DIFF;
  if (diffTruncated) diff = diff.slice(0, MAX_DIFF);

  const dir = join(ctx.stateDir, 'reviews', branchName(root).replace(/[^A-Za-z0-9._-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  const priors = readdirSync(dir)
    .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8')) as Round);
  const n = (priors.at(-1)?.round ?? 0) + 1;
  const good = priors.filter((p) => !p.error);

  const prompt = buildPrompt({ rules, rulesFile: config.review.rulesFile, base, diff, diffTruncated, priors: good, note: opts.roundNote });
  const command = process.env['VLITE_REVIEW_CMD'] || config.review.command;
  const line = [command, ...config.review.args.map(quoteArg)].join(' ');
  const r = await runShell(line, root, config.review.timeoutSec, prompt);

  const record: Round = {
    round: n,
    time: new Date().toISOString(),
    tree,
    base,
    rulesSource: rules === null ? 'missing' : 'base',
    diffTruncated,
    ...(opts.roundNote !== undefined ? { note: opts.roundNote } : {}),
    findings: [],
    rulesChecked: [],
    fixedFromPrior: [],
  };
  const path = join(dir, `${n}.json`);
  const parsed = r.code === 0 && !r.timedOut ? parseReply(r.output) : null;
  if (!parsed) {
    record.error = r.timedOut ? 'reviewer timed out' : r.code !== 0 ? `reviewer exit code ${String(r.code)}` : 'reply was not the JSON asked for';
    record.raw = r.output.slice(-20000);
    writeFileSync(path, JSON.stringify(record, null, 2));
    process.stderr.write(`VerdictLite review failed: ${record.error}. Raw reply saved in ${path}\n`);
    return 1;
  }
  record.findings = parsed.findings;
  record.rulesChecked = parsed.rulesChecked;
  const last = good.at(-1);
  if (last) {
    const key = (f: Finding): string => `${f.file}|${f.rule}`;
    const now = new Set(parsed.findings.map(key));
    record.fixedFromPrior = last.findings.filter((f) => f.severity === 'important' && !now.has(key(f)));
  }
  writeFileSync(path, JSON.stringify(record, null, 2));

  const important = parsed.findings.filter((f) => f.severity === 'important');
  const out = [`VerdictLite review round ${n} (base ${base ?? 'none'}, rules ${record.rulesSource})`];
  if (record.rulesSource === 'missing') out.push(`Note: ${config.review.rulesFile} is not on the base branch; the reviewer had no rules.`);
  if (diffTruncated) out.push('Note: the diff was cut at 200 KB.');
  for (const f of parsed.findings) out.push(`[${f.severity}] ${f.file}:${f.line} (${f.rule}) ${f.problem}${f.evidence ? `\n    evidence: ${f.evidence}` : ''}`);
  if (record.fixedFromPrior.length) out.push(`Fixed since last round: ${record.fixedFromPrior.length}`);
  out.push(`Rules checked: ${parsed.rulesChecked.join(', ') || '(none listed)'}`);
  out.push(`Saved: ${path}`);
  if (important.length === 0) {
    writeStamp(ctx, 'code-review', 'pass', [path], opts.roundNote, tree);
    out.push('No important findings. Wrote a code-review pass stamp for this tree.');
  } else out.push(`${important.length} important finding(s). No stamp. Fix them and run vlite review again.`);
  process.stdout.write(`${out.join('\n')}\n`);
  return important.length === 0 ? 0 : 2;
}

function buildPrompt(p: { rules: string | null; rulesFile: string; base: string | null; diff: string; diffTruncated: boolean; priors: Round[]; note: string | undefined }): string {
  const parts = [
    'You are the code reviewer for this change. Review only the diff below against the rules below.',
    'Run only the rules whose trigger matches something in the diff. Every finding needs a file and a line.',
    'Severity: "important" = must fix before merge; "nit" = small, optional; "pre-existing" = problem not added by this diff.',
    'Do not praise. Do not summarise. If nothing is wrong, return an empty findings list.',
    'Reply with STRICT JSON only, no prose, in exactly this shape:',
    '{"findings":[{"severity":"important|nit|pre-existing","file":"","line":0,"rule":"","problem":"","evidence":""}],"rulesChecked":["..."]}',
    '',
    p.rules === null
      ? `RULES: ${p.rulesFile} is missing on the base branch (${p.base ?? 'no base'}). Use general correctness rules and say so in rulesChecked.`
      : `RULES (${p.rulesFile} from ${p.base ?? ''}):\n${p.rules}`,
  ];
  if (p.priors.length > 0) {
    parts.push('', 'EARLIER ROUNDS on this branch. For each earlier important finding, check if this diff fixed it. Report it again if it is still there:');
    for (const r of p.priors) {
      parts.push(`Round ${r.round}${r.note ? ` (note: ${r.note})` : ''}: ${JSON.stringify(r.findings)}`);
      if (r.fixedFromPrior.length) parts.push(`  fixed by round ${r.round}: ${JSON.stringify(r.fixedFromPrior)}`);
    }
  }
  if (p.note) parts.push('', `Note from the author for this round: ${p.note}`);
  parts.push('', `DIFF (merge-base of ${p.base ?? 'empty tree'} to the working tree)${p.diffTruncated ? ', CUT at 200 KB' : ''}:`, p.diff || '(empty diff)');
  return parts.join('\n');
}

/** Finds the first balanced JSON object in the reply (code fences and chatter are ignored) and checks its shape. */
export function parseReply(text: string): { findings: Finding[]; rulesChecked: string[] } | null {
  const clean = text.replace(/```(?:json)?/gi, '');
  for (let start = clean.indexOf('{'); start !== -1; start = clean.indexOf('{', start + 1)) {
    const end = balancedEnd(clean, start);
    if (end === -1) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(clean.slice(start, end + 1));
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null || !Array.isArray((obj as { findings?: unknown }).findings)) continue;
    const raw = obj as { findings: unknown[]; rulesChecked?: unknown };
    const findings = raw.findings.filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null).map(toFinding);
    const rulesChecked = Array.isArray(raw.rulesChecked) ? raw.rulesChecked.map(String) : [];
    return { findings, rulesChecked };
  }
  return null;
}

function toFinding(f: Record<string, unknown>): Finding {
  const sev = SEVERITIES.find((s) => s === f['severity']) ?? 'important'; // unknown severity counts as important
  const s = (k: string): string => (typeof f[k] === 'string' ? (f[k] as string) : '');
  return { severity: sev, file: s('file'), line: Number(f['line']) || 0, rule: s('rule'), problem: s('problem'), evidence: s('evidence') };
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
