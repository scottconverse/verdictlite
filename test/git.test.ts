import { describe, expect, it } from 'vitest';
import { GIT_TIMEOUT_MS, git, gitOut } from '../src/git.js';
import { makeRepo } from './helpers.js';

describe('git timeout', () => {
  it('has a 300 s default', () => {
    expect(GIT_TIMEOUT_MS).toBe(300_000);
  });

  it('reports a call that runs too long as failed, never as success, and gitOut throws', () => {
    const r = makeRepo();
    const slow = ['-c', 'alias.slow=!sleep 5', 'slow'];
    const started = Date.now();
    const res = git(r.dir, slow, { timeoutMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.err).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(4500);
    expect(() => gitOut(r.dir, slow, { timeoutMs: 300 })).toThrow('timed out');
  });

  it('a normal call still works', () => {
    const r = makeRepo();
    expect(git(r.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()).toBe('feature');
  });
});
