import { describe, expect, it } from 'vitest';
import { matchAny, matchGlob } from '../src/glob.js';

describe('glob', () => {
  const cases: [string, string, boolean][] = [
    ['**/*.md', 'README.md', true],
    ['**/*.md', 'docs/a/b.md', true],
    ['**/*.md', 'docs/a/b.mdx', false],
    ['*.md', 'docs/a.md', false],
    ['*.md', 'a.md', true],
    ['docs/**', 'docs/x.png', true],
    ['docs/**', 'docs/a/b/c.txt', true],
    ['docs/**', 'mydocs/x', false],
    ['LICENSE*', 'LICENSE', true],
    ['LICENSE*', 'LICENSE.txt', true],
    ['LICENSE*', 'sub/LICENSE', false],
    ['**/SKILL.md', 'SKILL.md', true],
    ['**/SKILL.md', 'skills/x/SKILL.md', true],
    ['.claude/**', '.claude/settings.json', true],
    ['civiccast/**/*.py', 'civiccast/a.py', true],
    ['civiccast/**/*.py', 'civiccast/x/y/a.py', true],
    ['civiccast/**/*.py', 'other/a.py', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['src/?.ts', 'src//.ts', false],
    ['a.b', 'axb', false],
    ['(x)+[y]', '(x)+[y]', true],
    ['**', 'any/thing', true],
    ['src/**/test', 'src/test', true],
  ];
  for (const [pattern, path, want] of cases) {
    it(`${pattern} ${want ? 'matches' : 'does not match'} ${path}`, () => {
      expect(matchGlob(pattern, path)).toBe(want);
    });
  }
  it('treats backslashes in paths as separators', () => {
    expect(matchGlob('docs/**', 'docs\\a.md')).toBe(true);
  });
  it('matchAny', () => {
    expect(matchAny(['*.py', 'tests/**'], 'tests/x.ts')).toBe(true);
    expect(matchAny([], 'x')).toBe(false);
  });
});
