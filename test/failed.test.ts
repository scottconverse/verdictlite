import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedIdsOf, idsAreSafe, idsCommand, MAX_FAILED_IDS, parseFailedIds, stripAnsi } from '../src/failed.js';
import { tempDir } from './root.js';

function folder(files: string[]): string {
  const dir = tempDir('failed-');
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), 'x\n');
  }
  return dir;
}

describe('parseFailedIds', () => {
  it('reads pytest FAILED and ERROR lines and drops the message', () => {
    const out = ['=== short test summary info ===', 'FAILED tests/a.py::test_x - assert 1 == 2', 'FAILED tests/a.py::TestK::test_y[a b] - boom', 'ERROR tests/c.py', 'ERROR tests/d.py::test_z - fixture missing', '1 failed'].join('\n');
    expect(parseFailedIds(out)).toEqual(['tests/a.py::test_x', 'tests/a.py::TestK::test_y[a b]', 'tests/c.py', 'tests/d.py::test_z']);
  });

  it('reads vitest and jest FAIL lines and keeps the file only, once', () => {
    const out = [' FAIL  test/a.test.ts > adds numbers', ' FAIL  test/a.test.ts > subtracts', ' FAIL  test/b.test.ts', 'FAIL src/c.spec.ts (2.1 s)'].join('\n');
    expect(parseFailedIds(out)).toEqual(['test/a.test.ts', 'test/b.test.ts', 'src/c.spec.ts']);
  });

  it('strips ANSI colours first', () => {
    const out = '\u001b[31mFAILED\u001b[0m tests/a.py::test_x\r\n\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m test/b.test.ts';
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
    expect(parseFailedIds(out)).toEqual(['tests/a.py::test_x', 'test/b.test.ts']);
  });

  it('gives nothing for an unknown format', () => {
    expect(parseFailedIds('something broke\nexit 1\n')).toEqual([]);
    expect(parseFailedIds('')).toEqual([]);
  });
});

describe('idsAreSafe and failedIdsOf', () => {
  it('accepts ids whose file exists under the check folder', () => {
    const dir = folder(['tests/a.py', 'test/b.test.ts']);
    expect(idsAreSafe(['tests/a.py::test_x', 'test/b.test.ts'], dir)).toBe(true);
    expect(failedIdsOf('FAILED tests/a.py::test_x - no\n', dir)).toEqual(['tests/a.py::test_x']);
  });

  it('rejects an id that starts with a dash, has a line break, or names a missing file', () => {
    const dir = folder(['tests/a.py']);
    expect(idsAreSafe(['--exitfirst'], dir)).toBe(false);
    expect(idsAreSafe(['tests/a.py\nrm'], dir)).toBe(false);
    expect(idsAreSafe(['tests/missing.py::test_x'], dir)).toBe(false);
    expect(idsAreSafe([], dir)).toBe(false);
  });

  it('records nothing when ANY id is rejected', () => {
    const dir = folder(['tests/a.py']);
    expect(failedIdsOf('FAILED tests/a.py::test_x\nFAILED tests/gone.py::test_y\n', dir)).toBeNull();
    expect(failedIdsOf('FAILED -k\n', dir)).toBeNull();
  });

  it('records nothing when there are more than 50 ids', () => {
    const names = Array.from({ length: MAX_FAILED_IDS + 1 }, (_, i) => `tests/t${i}.py`);
    const dir = folder(names);
    expect(failedIdsOf(names.map((n) => `FAILED ${n}::test`).join('\n'), dir)).toBeNull();
    expect(failedIdsOf(names.slice(0, MAX_FAILED_IDS).map((n) => `FAILED ${n}::test`).join('\n'), dir)).toHaveLength(MAX_FAILED_IDS);
  });
});

describe('idsCommand', () => {
  it('puts the quoted ids where {files} was', () => {
    expect(idsCommand('pytest {files} -q', ['tests/a.py::test_x'])).toBe('pytest tests/a.py::test_x -q');
    const q = idsCommand('pytest {files}', ['tests/a.py::test_y[a b]']);
    expect(q).not.toBe('pytest tests/a.py::test_y[a b]');
    expect(q).toContain('test_y[a b]');
  });
});
