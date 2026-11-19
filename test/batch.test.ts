import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { expandBraces, matchGlob } from '../src/glob.js';
import { planParts } from '../src/parts.js';
import { runShell } from '../src/proc.js';
import { editedFiles, rootOf } from '../src/scope.js';
import { readState, updateState } from '../src/state.js';
import { detectTamper, type FileDiff } from '../src/tamper.js';
import { baseConfig, CHECK_SCRIPT, lastJson, makeRepo, type Repo } from './helpers.js';
import { tempDir } from './root.js';

function setup(extra: object = {}): Repo {
  return makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' }, baseConfig(extra));
}
const hook = (r: Repo, session = 's1', cwd = r.dir): string => JSON.stringify({ session_id: session, cwd, stop_hook_active: false });
const stateFolder = (r: Repo): string => join(r.home, readdirSync(r.home)[0] ?? '');

describe('updateState (fix 1)', () => {
  it('applies the change to fresh state, and many processes lose no update', async () => {
    const dir = tempDir('state-');
    updateState(dir, (s) => {
      s.rounds['a'] = 1;
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ rounds: { a: 1, other: 7 }, pending: {}, blocks: [] }));
    updateState(dir, (s) => {
      s.rounds['b'] = 2;
    });
    expect(readState(dir).rounds).toEqual({ a: 1, other: 7, b: 2 });

    const script = join(tempDir('script-'), 'w.mjs');
    const mod = new URL('../dist/state.js', import.meta.url).href;
    writeFileSync(script, `import { updateState } from ${JSON.stringify(mod)};\nfor (let i = 0; i < 15; i++) updateState(process.argv[2], (s) => { s.rounds.count = (s.rounds.count ?? 0) + 1; });\n`);
    const runs = [0, 1, 2, 3].map(
      () =>
        new Promise<number | null>((done) => {
          spawn(process.execPath, [script, dir], { stdio: 'ignore' }).on('close', done);
        }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0]);
    expect(readState(dir).rounds['count']).toBe(60);
  }, 60_000);

  it('removes a stale lock left by a crashed run', () => {
    const dir = tempDir('state-');
    const lock = join(dir, 'state.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    updateState(dir, (s) => {
      s.rounds['x'] = 1;
    });
    expect(readState(dir).rounds['x']).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('still blocks when the state cannot be saved', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    expect(r.vlite(['stop-check'], { input: hook(r) }).out).toContain('"block"'); // creates the state folder
    rmSync(join(stateFolder(r), 'state.json'));
    mkdirSync(join(stateFolder(r), 'state.json')); // a folder where the file goes: every save fails
    r.write('src/app.js', 'BAD again\n');
    const out = r.vlite(['stop-check'], { input: hook(r, 's2') });
    expect(lastJson(out.out)['decision']).toBe('block');
    expect(out.err).toContain('could not save state');
  }, 30_000);
});

describe('detached HEAD key (fix 2)', () => {
  it('keeps the previous pass tree as the start point after a commit in the same detached worktree', () => {
    const r = setup();
    r.git('checkout', '-q', '--detach');
    r.write('src/one.js', 'one\n');
    expect(r.vlite(['stop-check'], { input: hook(r) }).out).toBe('');
    r.commitAll('work one'); // the passed work is committed
    r.write('src/two.js', 'two\n');
    expect(r.vlite(['stop-check'], { input: hook(r, 's2') }).out).toBe('');
    const log = readFileSync(join(stateFolder(r), 'stop.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.at(-1)?.['changed']).toBe(1); // only the new edit
  });

  it('does not reuse an old tree when the same folder is reset to an unrelated newer commit', () => {
    const r = setup();
    r.git('checkout', '-q', '--detach');
    r.write('src/one.js', 'one\n');
    expect(r.vlite(['stop-check'], { input: hook(r) }).out).toBe('');
    r.git('checkout', '-q', '--orphan', 'other');
    r.git('rm', '-rfq', '--cached', '.');
    r.write('src/unrelated.js', 'u\n');
    r.git('add', 'src/unrelated.js');
    r.git('commit', '-q', '-m', 'unrelated root');
    r.git('checkout', '-q', '--detach');
    r.write('src/unrelated.js', 'edit\n');
    expect(r.vlite(['stop-check'], { input: hook(r, 's2') }).out).toBe('');
    const log = readFileSync(join(stateFolder(r), 'stop.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.at(-1)?.['from']).not.toBe(log.at(-2)?.['tree']);
  });
});

describe('runShell (fix 3)', () => {
  it('reports the exit code when a grandchild keeps the pipes open', async () => {
    const code = "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); c.unref(); console.log('pid ' + c.pid);";
    const started = Date.now();
    const r = await runShell(`"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`, tempDir('sh-'), 20);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(7000);
    const pid = Number(/pid (\d+)/.exec(r.output)?.[1]);
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
  }, 30_000);
});

describe('warnings and config (fix 4, 5)', () => {
  it('rejects an unknown top-level key and names it', () => {
    expect(() => parseConfig('{"version":1,"part":[]}', 'x')).toThrow(ConfigError);
    expect(() => parseConfig('{"version":1,"part":[]}', 'x')).toThrow(/"part"/);
    expect(() => parseConfig('{"version":1,"prChecks":[]}', 'x')).not.toThrow();
  });

  it('shows a typo in vlite.json to the person as a systemMessage', () => {
    const r = setup({ part: [] });
    r.write('src/app.js', 'BAD\n');
    const out = r.vlite(['stop-check'], { input: hook(r) });
    expect(out.code).toBe(0);
    expect(String(lastJson(out.out)['systemMessage'])).toContain('"part"');
  });

  it('--repo wins over the cwd in the hook JSON', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const elsewhere = tempDir('cwd-');
    expect(r.vlite(['stop-check'], { input: hook(r, 's1', elsewhere) }).out).toBe('');
    expect(lastJson(r.vlite(['stop-check', '--repo', r.dir], { input: hook(r, 's1', elsewhere) }).out)['decision']).toBe('block');
  });
});

describe('handoff (fix 6)', () => {
  it('starts again at round 1 after a handoff', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const rounds: string[] = [];
    for (let i = 0; i < 4; i++) {
      r.write('src/app.js', `BAD ${i}\n`);
      const j = lastJson(r.vlite(['stop-check'], { input: hook(r) }).out);
      rounds.push(j['decision'] === 'block' ? String(j['reason']).match(/Round (\d) of 3/)?.[1] ?? '?' : 'handoff');
    }
    expect(rounds).toEqual(['1', '2', 'handoff', '1']);
  }, 60_000);
});

describe('review (fix 7)', () => {
  const FAKE = "process.stdin.resume(); process.stdin.on('data',()=>{}); process.stdin.on('end',()=>process.stdout.write('{\"findings\":[],\"rulesChecked\":[]}'));";
  function run(r: Repo): { code: number; out: string; err: string } {
    const dir = tempDir('fake-');
    writeFileSync(join(dir, 'fake.mjs'), FAKE);
    return r.vlite(['review'], { env: { VLITE_REVIEW_CMD: `"${process.execPath}" "${join(dir, 'fake.mjs')}"` } });
  }
  const stamps = (r: Repo): number => {
    const f = join(stateFolder(r), 'stamps.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  };

  it('writes no pass stamp when the diff was truncated', () => {
    const r = makeRepo({ 'REVIEW.md': '## R1\n', 'src/app.js': 'a\n' }, baseConfig());
    r.write('src/big.js', `${'x'.repeat(100)}\n`.repeat(3000));
    const out = run(r);
    expect(out.out).toContain('NO code-review stamp');
    expect(out.out).toContain('cut at 200 KB');
    expect(out.code).toBe(2);
    expect(stamps(r)).toBe(0);
  });

  it('writes no pass stamp when the rules file is missing', () => {
    const r = makeRepo({ 'src/app.js': 'a\n' }, baseConfig());
    r.write('src/app.js', 'b\n');
    const out = run(r);
    expect(out.out).toContain('NO code-review stamp');
    expect(stamps(r)).toBe(0);
  });

  it('writes the stamp on a complete clean review, and skips a corrupt earlier round file', () => {
    const r = makeRepo({ 'REVIEW.md': '## R1\n', 'src/app.js': 'a\n' }, baseConfig());
    r.write('src/app.js', 'b\n');
    expect(run(r).code).toBe(0);
    const reviews = join(stateFolder(r), 'reviews');
    const folder = join(reviews, readdirSync(reviews)[0] ?? '');
    writeFileSync(join(folder, '1.json'), '{ torn');
    const again = run(r);
    expect(again.code, again.err).toBe(0);
    expect(existsSync(join(folder, '2.json'))).toBe(true);
    expect(stamps(r)).toBe(2);
  });
});

describe('--global paths (fix 8)', () => {
  it.skipIf(process.platform !== 'win32')('reads Git Bash style /c/dev/x as C:/dev/x', () => {
    const t = join(tempDir('tx-'), 't.jsonl');
    const line = (o: object): string => JSON.stringify(o);
    writeFileSync(
      t,
      [
        line({ type: 'user', message: { content: 'go' } }),
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/c/dev/x/a.ts' } }] } }),
      ].join('\n'),
    );
    expect(editedFiles(t, 'D:/other')[0]?.replace(/\\/g, '/')).toBe('C:/dev/x/a.ts');
  });

  it('finds a repo root for many files of one folder (cached)', () => {
    const r = setup();
    const first = rootOf(join(r.dir, 'src', 'a.js'));
    expect(first).not.toBeNull();
    expect(rootOf(join(r.dir, 'src', 'b.js'))).toBe(first);
  });
});

describe('brace globs (fix 9)', () => {
  it('expands alternation but leaves {name} alone', () => {
    expect(expandBraces('**/*.{spec,test}.ts')).toEqual(['**/*.spec.ts', '**/*.test.ts']);
    expect(expandBraces('src/{name}/**')).toEqual(['src/{name}/**']);
    expect(expandBraces('a/{b,c{d,e}}/f')).toEqual(['a/b/f', 'a/cd/f', 'a/ce/f']);
  });
  it('matches alternatives', () => {
    expect(matchGlob('**/*.{spec,test}.ts', 'src/a.test.ts')).toBe(true);
    expect(matchGlob('**/*.{spec,test}.ts', 'a.spec.ts')).toBe(true);
    expect(matchGlob('**/*.{spec,test}.ts', 'src/a.unit.ts')).toBe(false);
    expect(matchGlob('src/*.{ts,tsx}', 'src/x.tsx')).toBe(true);
  });
  it('works inside template part paths', () => {
    const cfg = parseConfig(
      JSON.stringify({ version: 1, parts: [{ name: 'm:{name}', paths: ['src/{name}/**/*.{ts,tsx}'], checks: [{ name: 'c', run: 'echo {name}' }] }] }),
      'x',
    );
    const plan = planParts(cfg.parts, ['src/alpha/a/b.tsx', 'src/beta/x.ts', 'src/gamma/x.md'], 12);
    expect(plan.parts.map((p) => p.name)).toEqual(['m:alpha', 'm:beta']);
  });
});

describe('tamper additions (fix 10)', () => {
  const add = (path: string, ...lines: string[]): FileDiff => ({ path, added: lines.map((text, i) => ({ line: i + 1, text })), removed: [] });
  const kinds = (d: FileDiff[]): string[] => detectTamper(d, ['tests/**', '**/*.test.ts'], 'TEST-REMOVALS.md').map((h) => h.kind);
  it.each([
    'pytestmark = pytest.mark.skip',
    '    marks=pytest.mark.skip(reason="x"),',
    '    pytest.importorskip("numpy")',
    '        self.skipTest("later")',
    "it.only('a', () => {})",
    "describe.only('a', () => {})",
    "test.only('a', () => {})",
    "fit('a', () => {})",
    "fdescribe('a', () => {})",
    "test.skipIf(isCI)('a', () => {})",
  ])('flags %s', (line) => {
    expect(kinds([add('tests/test_x.py', line)])).toContain('skip');
  });
  it('does not flag words that only contain fit(', () => {
    expect(kinds([add('tests/test_x.py', 'benefit(1)', 'const profit = 1', 'model.fit(x, y)')])).toEqual([]);
  });
  it('matches the removal log by whole word', () => {
    const removed: FileDiff = { path: 'tests/test_x.py', added: [], removed: [{ line: 1, text: 'def test_a():' }] };
    const log = (text: string): FileDiff => add('TEST-REMOVALS.md', text);
    expect(kinds([removed, log('- test_abc: gone')])).toEqual(['removed-test']);
    expect(kinds([removed, log('- test_a: gone')])).toEqual([]);
  });
});

describe('gate in observe mode (fix 11)', () => {
  it('never fails a commit on an unexpected error', () => {
    const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n' }, baseConfig({ gate: { mode: 'observe' } }));
    r.write('src/app.js', 'next\n');
    r.git('add', '-A');
    const folder = (): string => join(r.home, readdirSync(r.home)[0] ?? '');
    expect(r.vlite(['gate', 'pre-commit']).code).toBe(0); // creates the state folder
    rmSync(join(folder(), 'gate.jsonl'), { force: true });
    mkdirSync(join(folder(), 'gate.jsonl')); // a folder where the log goes: logging throws
    const msg = join(tempDir('msg-'), 'm.txt');
    writeFileSync(msg, 'a change\n');
    const out = r.vlite(['gate', 'commit-msg', msg]);
    expect(out.code).toBe(0);
    expect(out.err).toContain('gate error');
  });
  it('keeps exit 1 for an unexpected error in enforce mode', () => {
    const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n' }, baseConfig({ gate: { mode: 'enforce' } }));
    r.write('src/app.js', 'next\n');
    r.git('add', '-A');
    expect(r.vlite(['gate', 'pre-commit']).code).toBe(0);
    const g = join(r.home, readdirSync(r.home)[0] ?? '', 'gate.jsonl');
    rmSync(g, { force: true });
    mkdirSync(g);
    const msg = join(tempDir('msg-'), 'm.txt');
    writeFileSync(msg, 'a change\n\nVerify-Skip: test\n');
    expect(r.vlite(['gate', 'commit-msg', msg]).code).toBe(1);
  });
});
