import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Ctx } from './context.js';
import { headSha, worktreeTree } from './git.js';
import { readJsonl } from './state.js';

export type Method = 'verify' | 'code-review' | 'stop-check';

export interface StampRecord {
  time: string;
  method: Method;
  result: 'pass' | 'fail';
  tree: string;
  head: string | null;
  evidence: string[];
  note?: string;
}

export function writeStamp(ctx: Ctx, method: Method, result: 'pass' | 'fail', evidence: string[], note?: string, tree?: string): StampRecord {
  const paths = evidence.map((p) => resolve(p));
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length > 0) throw new UsageError(`evidence file not found: ${missing.join(', ')}`);
  const rec: Omit<StampRecord, 'time'> = {
    method,
    result,
    tree: tree ?? worktreeTree(ctx.root),
    head: headSha(ctx.root),
    evidence: paths,
    ...(note !== undefined ? { note } : {}),
  };
  ctx.log('stamps', rec);
  return { time: new Date().toISOString(), ...rec };
}

/** Methods whose latest stamp for this tree is a pass. */
export function passedMethods(ctx: Ctx, tree: string): Method[] {
  const latest = new Map<Method, StampRecord>();
  for (const s of readJsonl<StampRecord>(join(ctx.stateDir, 'stamps.jsonl'))) if (s.tree === tree) latest.set(s.method, s);
  return (['verify', 'code-review', 'stop-check'] as const).filter((m) => latest.get(m)?.result === 'pass');
}

export class UsageError extends Error {}
