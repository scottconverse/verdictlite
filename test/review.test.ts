import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tempDir } from './root.js';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReply } from '../src/review.js';
import { baseConfig, makeRepo, type Repo } from './helpers.js';

/** Fake reviewer: saves the prompt it got, then prints the reply file. */
const FAKE = `import { readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
writeFileSync(process.env.FAKE_PROMPT_OUT, prompt);
process.stdout.write(readFileSync(process.env.FAKE_REPLY, 'utf8'));
`;

function setup(): { r: Repo; run(reply: string, args?: string[]): { code: number; out: string; err: string; prompt: string } } {
  const r = makeRepo({ 'src/app.js': 'a\n', 'REVIEW.md': '## R1 no console.log\nTrigger: any .js file.\n' }, baseConfig({ review: { command: 'claude', args: ['-p'], rulesFile: 'REVIEW.md', timeoutSec: 60 } }));
  const tools = tempDir('fake-');
  writeFileSync(join(tools, 'fake.mjs'), FAKE);
  return {
    r,
    run(reply, args = []) {
      writeFileSync(join(tools, 'reply.txt'), reply);
      const promptOut = join(tools, 'prompt.txt');
      const out = r.vlite(['review', ...args], {
        env: {
          VLITE_REVIEW_CMD: `"${process.execPath}" "${join(tools, 'fake.mjs')}"`,
          FAKE_REPLY: join(tools, 'reply.txt'),
          FAKE_PROMPT_OUT: promptOut,
        },
      });
      return { ...out, prompt: existsSync(promptOut) ? readFileSync(promptOut, 'utf8') : '' };
    },
  };
}

function stamps(r: Repo): Record<string, unknown>[] {
  const [name] = readdirSync(r.home);
  const file = join(r.home, name ?? '', 'stamps.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

const IMPORTANT = JSON.stringify({
  findings: [{ severity: 'important', file: 'src/app.js', line: 1, rule: 'R1', problem: 'console.log left in', evidence: 'console.log(1)' }],
  rulesChecked: ['R1'],
});

describe('review', () => {
  it('clean review writes a code-review stamp for the current tree; rules come from the base, not the working tree', () => {
    const { r, run } = setup();
    r.write('src/app.js', 'b\n');
    r.write('REVIEW.md', 'WORKTREE RULES SHOULD NOT BE USED\n');
    const out = run('```json\n{"findings":[],"rulesChecked":["R1"]}\n```');
    expect(out.code, out.err).toBe(0);
    expect(out.out).toContain('No important findings');
    const rulesPart = out.prompt.slice(out.prompt.indexOf('RULES ('), out.prompt.indexOf('DIFF ('));
    expect(rulesPart).toContain('R1 no console.log');
    expect(rulesPart).not.toContain('WORKTREE RULES'); // the edit shows only in the diff, as a change to review
    expect(out.prompt).toContain('+b');
    const s = stamps(r);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ method: 'code-review', result: 'pass' });
    // the stamp counts at commit time for the same tree
    r.git('add', '-A');
    expect(s[0]?.['tree']).toBe(r.git('write-tree'));
  });

  it('an important finding exits 2 with no stamp; the next round sees the earlier findings', () => {
    const { r, run } = setup();
    r.write('src/app.js', 'console.log(1)\n');
    const one = run(`Here you go:\n${IMPORTANT}\nthanks`);
    expect(one.code).toBe(2);
    expect(one.out).toContain('[important] src/app.js:1 (R1) console.log left in');
    expect(stamps(r)).toHaveLength(0);

    r.write('src/app.js', 'fixed\n');
    const two = run('{"findings":[{"severity":"nit","file":"src/app.js","line":1,"rule":"style","problem":"name","evidence":""}],"rulesChecked":["R1"]}', ['--round-note', 'removed the log']);
    expect(two.code).toBe(0);
    expect(two.prompt).toContain('EARLIER ROUNDS');
    expect(two.prompt).toContain('console.log left in');
    expect(two.prompt).toContain('removed the log');
    expect(two.out).toContain('Fixed since last round: 1');
    const [name] = readdirSync(r.home);
    const round2 = JSON.parse(readFileSync(join(r.home, name ?? '', 'reviews', 'feature', '2.json'), 'utf8')) as { fixedFromPrior: unknown[]; note: string };
    expect(round2.fixedFromPrior).toHaveLength(1);
    expect(round2.note).toBe('removed the log');
  });

  it('bad JSON exits 1, saves the raw reply and writes no stamp', () => {
    const { r, run } = setup();
    r.write('src/app.js', 'b\n');
    const out = run('I think it looks great!');
    expect(out.code).toBe(1);
    expect(out.err).toContain('not the JSON asked for');
    expect(stamps(r)).toHaveLength(0);
  });

  it('says so when the rules file is missing on the base', () => {
    const { r, run } = setup();
    r.git('rm', '-q', 'REVIEW.md');
    r.git('commit', '-q', '-m', 'drop rules on the branch');
    r.git('checkout', '-q', 'main');
    r.git('rm', '-q', 'REVIEW.md');
    r.git('commit', '-q', '-m', 'drop rules on main');
    r.git('checkout', '-q', 'feature');
    r.write('REVIEW.md', 'local rules only\n');
    const out = run('{"findings":[],"rulesChecked":[]}');
    expect(out.prompt).toContain('RULES: REVIEW.md is missing on the base branch (main)');
    expect(out.prompt).not.toContain('RULES (REVIEW.md');
    expect(out.out).toContain('rules missing');
  });
});

describe('parseReply', () => {
  it('finds the first balanced object that has findings, ignoring braces in strings', () => {
    const text = 'noise {"x":1} more {"findings":[{"severity":"weird","file":"a{b}.ts","line":"7","rule":"r","problem":"p \\" }","evidence":""}]}';
    const got = parseReply(text);
    expect(got?.findings[0]).toEqual({ severity: 'important', file: 'a{b}.ts', line: 7, rule: 'r', problem: 'p " }', evidence: '' });
  });
  it('returns null when there is no usable object', () => {
    expect(parseReply('nothing here')).toBeNull();
    expect(parseReply('{"findings": "no"}')).toBeNull();
    expect(parseReply('{ broken')).toBeNull();
  });
});
