import { describe, expect, it } from 'vitest';
import { type Part, parseConfig } from '../src/config.js';
import { templateToRegExp } from '../src/glob.js';
import { bindNames, expandPart, planParts, SAFE_NAME } from '../src/parts.js';

function parts(list: object[]): Part[] {
  return parseConfig(JSON.stringify({ version: 1, parts: list }), 'test').parts;
}

const backend = {
  name: 'backend:{name}',
  paths: ['civiccast/{name}/**', 'tests/{name}/**'],
  requires: ['tests/{name}'],
  checks: [{ name: 'tests', run: 'uv run --no-sync pytest tests/{name} -q -x', timeoutSec: 600 }],
};

describe('template regex', () => {
  it('{name} is one whole segment and ** still works around it', () => {
    const re = templateToRegExp('civiccast/{name}/**');
    expect(re.exec('civiccast/egress/a.py')?.[1]).toBe('egress');
    expect(re.exec('civiccast/egress/deep/b.py')?.[1]).toBe('egress');
    expect(re.exec('civiccast/a.py')).toBeNull(); // a file directly in civiccast/ is not a module
    expect(re.exec('civiccast/egress')).toBeNull();
    expect(re.exec('other/egress/a.py')).toBeNull();
  });
  it('a second {name} must match the same text', () => {
    const re = templateToRegExp('src/{name}/tests/{name}_test.py');
    expect(re.exec('src/a/tests/a_test.py')?.[1]).toBe('a');
    expect(re.exec('src/a/tests/b_test.py')).toBeNull();
  });
});

describe('binding', () => {
  const [tpl] = parts([backend]) as [Part];

  it('marks the part as a template', () => {
    expect(tpl.template).toBe(true);
    expect(parts([{ name: 'plain', paths: ['src/**'], checks: [{ name: 'c', run: 'x' }] }])[0]?.template).toBe(false);
  });

  it('binds one value per changed module, deduped and sorted', () => {
    expect(bindNames(tpl, ['civiccast/zeta/a.py', 'civiccast/egress/a.py', 'civiccast/egress/b.py', 'README.md'])).toEqual(['egress', 'zeta']);
  });

  it('two templated paths that bind the same name give one part', () => {
    expect(bindNames(tpl, ['civiccast/egress/a.py', 'tests/egress/test_a.py'])).toEqual(['egress']);
    expect(planParts([tpl], ['civiccast/egress/a.py', 'tests/egress/test_a.py'], 12).parts.map((p) => p.name)).toEqual(['backend:egress']);
  });

  it('treats backslashes as separators', () => {
    expect(bindNames(tpl, ['civiccast\\egress\\a.py'])).toEqual(['egress']);
  });

  it('never binds an unsafe name', () => {
    const unsafe = ['a;rm -rf x', 'two words', '$HOME', '$(id)', '`id`', 'a&b', 'a|b', "it's", '"q"', '-rf', '.hidden', 'a>b', 'a\tb', 'ü'];
    for (const v of unsafe) expect(SAFE_NAME.test(v), v).toBe(false);
    const files = unsafe.map((v) => `civiccast/${v}/y.py`);
    expect(bindNames(tpl, files)).toEqual([]);
    expect(planParts([tpl], files, 12)).toEqual({ parts: [], tooMany: [] });
    expect(bindNames(tpl, [...files, 'civiccast/ok_1.2-b/y.py'])).toEqual(['ok_1.2-b']);
  });

  it('fills {name} in name, paths, requires, cwd and run, and leaves other braces alone', () => {
    const [t] = parts([{ ...backend, cwd: 'svc/{name}', checks: [{ name: 'tests', run: 'echo ${HOME} {other} {name}' }] }]) as [Part];
    const p = expandPart(t, 'egress');
    expect(p).toMatchObject({
      name: 'backend:egress',
      paths: ['civiccast/egress/**', 'tests/egress/**'],
      requires: ['tests/egress'],
      cwd: 'svc/egress',
      template: false,
    });
    expect(p.checks[0]).toMatchObject({ run: 'echo ${HOME} {other} egress', cwd: 'svc/egress' });
  });
});

describe('planParts', () => {
  const list = parts([
    { name: 'first', paths: ['civiccast/**'], checks: [{ name: 'c', run: 'x' }] },
    backend,
    { name: 'docs', paths: ['site/**'], checks: [{ name: 'c', run: 'x' }] },
  ]);

  it('keeps config order and leaves plain parts as they are', () => {
    const plan = planParts(list, ['civiccast/b/x.py', 'civiccast/a/x.py'], 12);
    expect(plan.parts.map((p) => p.name)).toEqual(['first', 'backend:a', 'backend:b']);
    expect(plan.parts[0]).toBe(list[0]);
  });

  it('runs none of a template past the cap and reports every name', () => {
    const plan = planParts(list, ['civiccast/a/x', 'civiccast/b/x', 'civiccast/c/x'], 2);
    expect(plan.parts.map((p) => p.name)).toEqual(['first']);
    expect(plan.tooMany).toEqual([{ template: 'backend:{name}', names: ['backend:a', 'backend:b', 'backend:c'] }]);
    expect(planParts(list, ['civiccast/a/x', 'civiccast/b/x'], 2).tooMany).toEqual([]);
  });
});
