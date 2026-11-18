import { describe, expect, it } from 'vitest';
import { detectTamper, type FileDiff, parseDiff } from '../src/tamper.js';

const TESTS = ['tests/**', '**/*.test.ts', '**/*.spec.ts'];
const LOG = 'TEST-REMOVALS.md';

const add = (path: string, ...lines: string[]): FileDiff => ({ path, added: lines.map((text, i) => ({ line: i + 1, text })), removed: [] });
const del = (path: string, ...lines: string[]): FileDiff => ({ path, added: [], removed: lines.map((text, i) => ({ line: i + 1, text })) });
const kinds = (d: FileDiff[]): string[] => detectTamper(d, TESTS, LOG).map((h) => h.kind);

describe('parseDiff', () => {
  it('reads added and removed lines with line numbers, CRLF and deleted files', () => {
    const text = [
      'diff --git a/tests/test_a.py b/tests/test_a.py',
      'index 1..2 100644',
      '--- a/tests/test_a.py',
      '+++ b/tests/test_a.py',
      '@@ -3 +3,2 @@ def x():',
      '-    old line\r',
      '+    new line\r',
      '+++ starts with plus',
      'diff --git a/tests/gone.py b/tests/gone.py',
      'deleted file mode 100644',
      '--- a/tests/gone.py',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-def test_gone():',
      '-    pass',
    ].join('\n');
    const files = parseDiff(text);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      path: 'tests/test_a.py',
      added: [
        { line: 3, text: '    new line' },
        { line: 4, text: '++ starts with plus' },
      ],
      removed: [{ line: 3, text: '    old line' }],
    });
    expect(files[1]?.path).toBe('tests/gone.py');
    expect(files[1]?.removed[0]).toEqual({ line: 1, text: 'def test_gone():' });
  });
});

describe('test-tamper detectors', () => {
  describe('skip markers (red)', () => {
    for (const line of [
      '@pytest.mark.skip(reason="later")',
      '@pytest.mark.skipif(sys.platform == "win32", reason="x")',
      '    pytest.skip("flaky")',
      '@unittest.skip("x")',
      '@pytest.mark.xfail',
      "it.skip('works', () => {})",
      "test.skip('works', () => {})",
      "describe.skip('group', () => {})",
      "xit('works', () => {})",
      "test.fixme('works', async () => {})",
    ]) {
      it(line, () => expect(kinds([add('tests/test_x.py', line)])).toContain('skip'));
    }
  });
  it('skip markers outside test files are ignored (green)', () => {
    expect(kinds([add('src/app.ts', "it.skip('x')")])).toEqual([]);
  });
  it('normal test code passes (green)', () => {
    expect(kinds([add('tests/test_x.py', 'def test_new():', '    assert skip_count == 0')])).toEqual([]);
    expect(kinds([add('src/a.test.ts', "it('skips nothing', () => expect(1).toBe(1));")])).toEqual([]);
  });

  describe('sleeps (red)', () => {
    for (const line of [
      '    time.sleep(2)',
      '    await asyncio.sleep(0.5)',
      '  await page.waitForTimeout(1000);',
      '  await new Promise((r) => setTimeout(r, 500));',
      "  await setTimeout(100); // from 'timers/promises'",
      '  setTimeout(resolve, 100);',
    ]) {
      it(line, () => expect(kinds([add('tests/a.spec.ts', line)])).toContain('sleep'));
    }
  });
  it('a setTimeout callback that is not a wait passes (green)', () => {
    expect(kinds([add('tests/a.spec.ts', 'setTimeout(() => emitter.emit("x"), 0); // drives the code under test')])).toEqual([]);
  });

  describe('retries (red)', () => {
    it('raised retries in playwright config', () => {
      const d: FileDiff = { path: 'playwright.config.ts', added: [{ line: 5, text: '  retries: 3,' }], removed: [{ line: 5, text: '  retries: 0,' }] };
      expect(kinds([d])).toEqual(['retry']);
    });
    it('@flaky, pytest.mark.flaky, --reruns', () => {
      expect(kinds([add('tests/test_a.py', '@flaky(max_runs=3)')])).toEqual(['retry']);
      expect(kinds([add('tests/test_a.py', '@pytest.mark.flaky(reruns=2)')])).toEqual(['retry']);
      expect(kinds([add('pyproject.toml', 'addopts = "--reruns 3"')])).toEqual(['retry']);
    });
  });
  it('lowered retries pass (green)', () => {
    const d: FileDiff = { path: 'vitest.config.ts', added: [{ line: 5, text: '  retries: 0,' }], removed: [{ line: 5, text: '  retries: 2,' }] };
    expect(kinds([d])).toEqual([]);
  });

  describe('removed tests', () => {
    it('a removed python test fails (red)', () => {
      const hits = detectTamper([del('tests/test_a.py', 'def test_login_rejects_bad_password():')], TESTS, LOG);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe('removed-test');
      expect(hits[0]?.advice).toContain('TEST-REMOVALS.md');
    });
    it('a removed JS test fails (red)', () => {
      expect(kinds([del('src/x.test.ts', "  it('rounds half up', () => {")])).toEqual(['removed-test']);
      expect(kinds([del('src/x.spec.ts', '  test("saves the file", async () => {')])).toEqual(['removed-test']);
    });
    it('a test moved to another file passes (green)', () => {
      expect(kinds([del('tests/test_a.py', 'def test_moved():'), add('tests/test_b.py', 'def test_moved():')])).toEqual([]);
    });
    it('a test whose signature changed passes (green)', () => {
      const d: FileDiff = { path: 'tests/test_a.py', added: [{ line: 1, text: 'def test_a(tmp_path):' }], removed: [{ line: 1, text: 'def test_a():' }] };
      expect(kinds([d])).toEqual([]);
    });
    it('a removal written down in the removals log passes (green)', () => {
      expect(kinds([del('tests/test_a.py', 'def test_old_api():'), add(LOG, '- test_old_api: the old API was deleted in this change')])).toEqual([]);
    });
    it('a name only in an unchanged (not added) log line does not count (red)', () => {
      const log: FileDiff = { path: LOG, added: [], removed: [{ line: 1, text: 'test_old_api' }] };
      expect(kinds([del('tests/test_a.py', 'def test_old_api():'), log])).toEqual(['removed-test']);
    });
  });
});
