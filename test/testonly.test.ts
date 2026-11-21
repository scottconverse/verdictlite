import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { baseConfig, lastJson, makeRepo, type Repo } from './helpers.js';
import { tempDir } from './root.js';

/** Records what it was given in the file named by argv[2], one line per run. Exits 1 when a file it was given says FAILME. */
const REC = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [out, mode, ...files] = process.argv.slice(2);
appendFileSync(out, mode + ' ' + files.join(',') + '\\n');
for (const f of files) if (existsSync(f) && readFileSync(f, 'utf8').includes('FAILME')) { console.log('failing file: ' + f); process.exit(1); }
`;

const T = (n: string, extra = ''): string => `def test_${n}():\n    assert True\n    assert 1 == 1\n${extra}`;

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => l.trimEnd()) : []);

interface Setup {
  r: Repo;
  out: string;
  runs(): string[];
}

function setup(runFiles: boolean = true): Setup {
  const out = join(tempDir('rec-'), 'runs.log').replace(/\\/g, '/');
  const check: Record<string, unknown> = { name: 'tests', run: `node rec.mjs ${out} FULL`, timeoutSec: 60 };
  if (runFiles) check['runFiles'] = `node rec.mjs ${out} NARROW {files}`;
  const r = makeRepo(
    { 'rec.mjs': REC, 'src/app.js': 'v1\n', 'tests/test_a.py': T('a'), 'tests/test_b.py': T('b') },
    baseConfig({ parts: [{ name: 'app', paths: ['src/**', 'tests/**'], checks: [check] }] }),
  );
  return { r, out, runs: () => lines(out) };
}

function stopLog(r: Repo): Record<string, unknown>[] {
  const [name] = readdirSync(r.home);
  return readFileSync(join(r.home, name ?? '', 'stop.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const stop = (r: Repo): { out: string; json: Record<string, unknown> } => {
  const res = r.vlite(['stop-check', '--session', 's']);
  return { out: res.out, json: res.out.trim() ? lastJson(res.out) : {} };
};

/** First turn: a product change runs the whole part and records the pass. */
function firstPass(s: Setup): void {
  s.r.write('src/app.js', 'v2\n');
  expect(stop(s.r).out).toBe('');
  expect(s.runs()).toEqual(['FULL']);
}

describe('test-only rerun', () => {
  it('runs only the changed test file after the part passed, and says so', () => {
    const s = setup();
    firstPass(s);
    s.r.write('tests/test_a.py', T('a', '    assert 2 == 2\n'));
    const { json } = stop(s.r);
    expect(s.runs()).toEqual(['FULL', 'NARROW tests/test_a.py']);
    expect(String(json['systemMessage'])).toContain('app/tests ran only the changed test files (tests/test_a.py)');
    const rec = stopLog(s.r).at(-1);
    expect(rec).toMatchObject({ result: 'pass', ran: ['app/tests'], narrow: { 'app/tests': ['tests/test_a.py'] } });
  });

  it('a failing narrow run names the test files that ran and why the rest was skipped', () => {
    const s = setup();
    firstPass(s);
    s.r.write('tests/test_a.py', `${T('a')}# FAILME\n`);
    const reason = String(stop(s.r).json['reason']);
    expect(reason).toContain('[app/tests] failed');
    expect(reason).toContain('Only these test files ran: tests/test_a.py.');
    expect(reason).toContain('skipped because product code is unchanged since the last pass of this part (tree ');
    expect(s.runs().at(-1)).toBe('NARROW tests/test_a.py');
    // the part did not pass, so after the fix a test-only change still narrows against the earlier pass
    s.r.write('tests/test_a.py', T('a', '    assert 3 == 3\n'));
    expect(stop(s.r).json['systemMessage']).toBeDefined();
    expect(s.runs().at(-1)).toBe('NARROW tests/test_a.py');
  });

  it('runs the full check when a product file in the part changed too', () => {
    const s = setup();
    firstPass(s);
    s.r.write('tests/test_a.py', T('a', '    assert 2 == 2\n'));
    s.r.write('src/app.js', 'v3\n');
    const { out } = stop(s.r);
    expect(out).toBe('');
    expect(s.runs()).toEqual(['FULL', 'FULL']);
  });

  it('a check without runFiles runs in full and prints one note line', () => {
    const s = setup(false);
    firstPass(s);
    s.r.write('tests/test_a.py', T('a', '    assert 2 == 2\n'));
    const { json } = stop(s.r);
    expect(s.runs()).toEqual(['FULL', 'FULL']);
    expect(String(json['systemMessage'])).toBe('VerdictLite: app/tests has no "runFiles", so it ran in full.');
  });

  it('still blocks a removed test (test-tamper), even in narrow mode', () => {
    const s = setup();
    firstPass(s);
    // test_a is gone: a removed test (the tamper check does not look at single assertions)
    s.r.write('tests/test_a.py', T('a2'));
    const reason = String(stop(s.r).json['reason']);
    expect(reason).toContain('[test-tamper] failed');
    expect(s.runs().at(-1)).toBe('NARROW tests/test_a.py');
  });

  it('reports a deleted test file, and runs the part in full when every changed test was deleted', () => {
    const s = setup();
    firstPass(s);
    s.r.write('tests/test_a.py', T('a', '    assert 2 == 2\n'));
    rmSync(join(s.r.dir, 'tests/test_b.py'));
    s.r.write('TEST-REMOVALS.md', 'test_b: replaced by test_a\n');
    const { json } = stop(s.r);
    expect(s.runs().at(-1)).toBe('NARROW tests/test_a.py');
    expect(String(json['systemMessage'])).toContain('tests/test_b.py (deleted, not run)');
    expect(stopLog(s.r).at(-1)?.['deleted']).toEqual(['tests/test_b.py (deleted, not run)']);

    const t = setup();
    firstPass(t);
    rmSync(join(t.r.dir, 'tests/test_b.py'));
    t.r.write('TEST-REMOVALS.md', 'test_b: not needed\n');
    const msg = String(stop(t.r).json['systemMessage']);
    expect(t.runs()).toEqual(['FULL', 'FULL']);
    expect(msg).toContain('every changed test file was deleted (tests/test_b.py), so the part ran in full');
  });

  it('quotes file names and gives paths relative to the check folder', () => {
    const out = join(tempDir('rec-'), 'runs.log').replace(/\\/g, '/');
    const r = makeRepo(
      { 'rec.mjs': REC, 'pkg/src/app.js': 'v1\n', 'pkg/tests/test_one two.py': T('a') },
      baseConfig({
        tests: { paths: ['pkg/tests/**'], removalsLog: 'TEST-REMOVALS.md' },
        parts: [{ name: 'pkg', paths: ['pkg/**'], cwd: 'pkg', checks: [{ name: 't', run: `node ../rec.mjs ${out} FULL`, runFiles: `node ../rec.mjs ${out} NARROW {files}` }] }],
      }),
    );
    r.write('pkg/src/app.js', 'v2\n');
    expect(stop(r).out).toBe('');
    r.write('pkg/tests/test_one two.py', T('a', '    assert 2 == 2\n'));
    stop(r);
    expect(lines(out).at(-1)).toBe('NARROW tests/test_one two.py');
  });

  it('fills {name} in runFiles for template parts', () => {
    const out = join(tempDir('rec-'), 'runs.log').replace(/\\/g, '/');
    const r = makeRepo(
      { 'rec.mjs': REC, 'src/m1/app.js': 'v1\n', 'tests/m1/test_a.py': T('a') },
      baseConfig({
        parts: [{ name: 'mod:{name}', paths: ['src/{name}/**', 'tests/{name}/**'], checks: [{ name: 't', run: `node rec.mjs ${out} FULL-{name}`, runFiles: `node rec.mjs ${out} NARROW-{name} {files}` }] }],
      }),
    );
    r.write('src/m1/app.js', 'v2\n');
    stop(r);
    r.write('tests/m1/test_a.py', T('a', '    assert 2 == 2\n'));
    stop(r);
    expect(lines(out)).toEqual(['FULL-m1', 'NARROW-m1 tests/m1/test_a.py']);
  });

  it('config rejects a runFiles without {files}', () => {
    const cfg = (runFiles: string): string => JSON.stringify({ version: 1, parts: [{ name: 'a', paths: ['src/**'], checks: [{ name: 't', run: 'x', runFiles }] }] });
    expect(() => parseConfig(cfg('pytest tests -q'), 'test')).toThrow(/checks\[0\]\.runFiles must contain \{files\}/);
    expect(parseConfig(cfg('pytest {files} -q'), 'test').parts[0]?.checks[0]?.runFiles).toBe('pytest {files} -q');
  });
});

describe('narrow mode only for real test files (finding 002)', () => {
  const stamps = (r: Repo): Record<string, unknown>[] => {
    const [name] = readdirSync(r.home);
    const file = join(r.home, name ?? '', 'stamps.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };

  it('a changed helper under tests.paths forces the full check', () => {
    const s = setup();
    firstPass(s);
    s.r.write('tests/helper.js', 'module.exports = 1;\n');
    expect(stop(s.r).out).toBe('');
    expect(s.runs()).toEqual(['FULL', 'FULL']);
    expect(stopLog(s.r).at(-1)).not.toHaveProperty('narrow');
  });

  it('a helper changed together with a test file forces the full check', () => {
    const s = setup();
    firstPass(s);
    s.r.write('tests/test_a.py', T('a', '    assert 2 == 2\n'));
    s.r.write('tests/conftest.py', 'import pytest\n');
    stop(s.r);
    expect(s.runs()).toEqual(['FULL', 'FULL']);
  });

  it('every default test file pattern still runs narrow', () => {
    for (const file of ['tests/test_x.py', 'tests/x_test.py', 'tests/x.test.ts', 'tests/x.spec.js', 'tests/x_test.go']) {
      const s = setup();
      firstPass(s);
      s.r.write(file, 'x\n');
      stop(s.r);
      expect(s.runs(), file).toEqual(['FULL', `NARROW ${file}`]);
    }
  });

  it('tests.files in vlite.json replaces the default patterns', () => {
    const out = join(tempDir('rec-'), 'runs.log').replace(/\\/g, '/');
    const r = makeRepo(
      { 'rec.mjs': REC, 'src/app.js': 'v1\n', 'tests/check_a.py': T('a') },
      baseConfig({
        tests: { paths: ['tests/**'], files: ['**/check_*.py'], removalsLog: 'TEST-REMOVALS.md' },
        parts: [{ name: 'app', paths: ['src/**', 'tests/**'], checks: [{ name: 'tests', run: `node rec.mjs ${out} FULL`, runFiles: `node rec.mjs ${out} NARROW {files}`, timeoutSec: 60 }] }],
      }),
    );
    r.write('src/app.js', 'v2\n');
    stop(r);
    r.write('tests/check_a.py', T('a', '    assert 2 == 2\n'));
    stop(r);
    r.write('tests/test_a.py', T('a'));
    stop(r);
    expect(lines(out)).toEqual(['FULL', 'NARROW tests/check_a.py', 'FULL']);
  });

  it('a bad tests.files is a config error', () => {
    expect(() => parseConfig(JSON.stringify({ version: 1, tests: { files: 'x' } }), 'x')).toThrow('"tests.files" must be a list of strings');
    expect(parseConfig(JSON.stringify({ version: 1 }), 'x').tests.files).toContain('**/test_*.py');
  });

  it('a narrow pass writes a stop-check stamp that says it was narrow; a full pass does not', () => {
    const s = setup();
    firstPass(s);
    expect(stamps(s.r).at(-1)).toMatchObject({ method: 'stop-check', result: 'pass', note: 'stop-check pass' });
    s.r.write('tests/test_a.py', T('a', '    assert 2 == 2\n'));
    stop(s.r);
    expect(stamps(s.r).at(-1)).toMatchObject({ method: 'stop-check', result: 'pass', note: 'stop-check pass (narrow: only changed test files ran)' });
  });
});
