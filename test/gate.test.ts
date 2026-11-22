import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseConfig, CHECK_SCRIPT, makeRepo, type Repo } from './helpers.js';

function setup(mode: 'off' | 'observe' | 'enforce'): Repo {
  const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n' }, baseConfig({ gate: { mode } }));
  const out = r.vlite(['install']);
  expect(out.code, out.err).toBe(0);
  return r;
}

function gateLog(r: Repo): Record<string, unknown>[] {
  const [name] = readdirSync(r.home);
  return readFileSync(join(r.home, name ?? '', 'gate.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Commits through the real hooks; returns git's exit code and stderr. */
function commit(r: Repo, message: string): { ok: boolean; err: string } {
  r.git('add', '-A');
  const file = join(r.dir, '.git', 'test-msg.txt'); // inside .git: not part of the work tree
  writeFileSync(file, message);
  try {
    r.git('commit', '-q', '-F', file);
    return { ok: true, err: '' };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

const trailer = (r: Repo): string => r.git('log', '-1', '--format=%(trailers:key=Verified-By,valueonly)').trim();

describe('stamp', () => {
  it('records method, result, tree, head, evidence and note', () => {
    const r = setup('observe');
    r.write('src/app.js', 'better\n');
    r.write('ev.log', 'tests passed\n');
    const out = r.vlite(['stamp', 'verify', '--result', 'pass', '--evidence', 'ev.log', '--note', 'ran pytest']);
    expect(out.code, out.err).toBe(0);
    const [name] = readdirSync(r.home);
    const rec = JSON.parse(readFileSync(join(r.home, name ?? '', 'stamps.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    expect(rec).toMatchObject({ method: 'verify', result: 'pass', head: r.git('rev-parse', 'HEAD'), note: 'ran pytest' });
    expect(rec['tree']).toMatch(/^[0-9a-f]{40}$/);
    expect(String((rec['evidence'] as string[])[0])).toMatch(/ev\.log$/);
    expect(typeof rec['time']).toBe('string');
  });

  it('refuses missing evidence and bad arguments', () => {
    const r = setup('observe');
    expect(r.vlite(['stamp', 'verify', '--result', 'pass', '--evidence', 'nope.log']).err).toContain('evidence file not found');
    expect(r.vlite(['stamp', 'verify', '--result', 'maybe']).code).toBe(1);
    expect(r.vlite(['stamp', 'guess', '--result', 'pass']).code).toBe(1);
  });
});

describe('gate', () => {
  it('observe: lets an unverified commit through, adds Verified-By: none and logs wouldBlock', () => {
    const r = setup('observe');
    r.write('src/app.js', 'changed\n');
    expect(commit(r, 'feat: change').ok).toBe(true);
    expect(trailer(r)).toBe('none');
    const log = gateLog(r);
    expect(log.find((x) => x['hook'] === 'pre-commit')).toMatchObject({ wouldBlock: true, method: 'none' });
    expect(log.at(-1)).toMatchObject({ hook: 'commit-msg', method: 'none', wouldBlock: true });
  });

  it('a pass stamp on the exact tree gives verify, both stamps give verify+code-review', () => {
    const r = setup('enforce');
    r.write('src/app.js', 'changed\n');
    r.vlite(['stamp', 'verify', '--result', 'pass']);
    expect(commit(r, 'feat: one').ok).toBe(true);
    expect(trailer(r)).toBe('verify');

    r.write('src/app.js', 'changed twice\n');
    r.vlite(['stamp', 'verify', '--result', 'pass']);
    r.vlite(['stamp', 'code-review', '--result', 'pass']);
    expect(commit(r, 'feat: two').ok).toBe(true);
    expect(trailer(r)).toBe('verify+code-review');
  });

  it('a stamp for another tree, or a later fail stamp, does not count', () => {
    const r = setup('observe');
    r.write('src/app.js', 'v1\n');
    r.vlite(['stamp', 'verify', '--result', 'pass']);
    r.write('src/app.js', 'v2\n');
    expect(commit(r, 'feat: x').ok).toBe(true);
    expect(trailer(r)).toBe('none');
    r.write('src/app.js', 'v3\n');
    r.vlite(['stamp', 'verify', '--result', 'pass']);
    r.vlite(['stamp', 'verify', '--result', 'fail']);
    expect(commit(r, 'feat: y').ok).toBe(true);
    expect(trailer(r)).toBe('none');
  });

  it('docs-only staged change gets method docs', () => {
    const r = setup('enforce');
    r.write('docs/a.md', 'words\n');
    expect(commit(r, 'docs: words').ok).toBe(true);
    expect(trailer(r)).toBe('docs');
  });

  it('enforce: blocks none, Verify-Skip lets it through and is logged', () => {
    const r = setup('enforce');
    r.write('src/app.js', 'changed\n');
    const blocked = commit(r, 'feat: change');
    expect(blocked.ok).toBe(false);
    expect(blocked.err).toContain('commit blocked');
    expect(blocked.err).toContain('Verify-Skip');
    expect(commit(r, 'feat: change\n\nVerify-Skip: generated file, checked by hand\n').ok).toBe(true);
    expect(trailer(r)).toBe('skipped');
    expect(gateLog(r).at(-1)).toMatchObject({ method: 'skipped', skipReason: 'generated file, checked by hand' });
  });

  it('enforce: after two blocks in 30 minutes the third attempt goes through, logged as escape', () => {
    const r = setup('enforce');
    r.write('src/app.js', 'changed\n');
    expect(commit(r, 'feat: a').ok).toBe(false);
    expect(commit(r, 'feat: a').ok).toBe(false);
    expect(commit(r, 'feat: a').ok).toBe(true);
    expect(trailer(r)).toBe('none');
    expect(gateLog(r).at(-1)).toMatchObject({ escape: true, method: 'none' });
    r.write('src/app.js', 'changed again\n');
    expect(commit(r, 'feat: b').ok).toBe(false); // the escape used up the two blocks
  });

  it('keeps existing trailers and replaces an old Verified-By', () => {
    const r = setup('observe');
    r.write('src/app.js', 'changed\n');
    r.vlite(['stamp', 'verify', '--result', 'pass']);
    const msg = 'feat: x\n\nBody text.\n\nVerified-By: something-old\nSigned-off-by: A <a@example.com>\nCo-Authored-By: B <b@example.com>\n';
    expect(commit(r, msg).ok).toBe(true);
    const body = r.git('log', '-1', '--format=%B');
    expect(body).toContain('Signed-off-by: A <a@example.com>');
    expect(body).toContain('Co-Authored-By: B <b@example.com>');
    expect(body).toContain('Verified-By: verify');
    expect(body).not.toContain('something-old');
    expect(body.match(/Verified-By/g)).toHaveLength(1);
  });

  it('off: no trailer, no log', () => {
    const r = setup('off');
    r.write('src/app.js', 'changed\n');
    expect(commit(r, 'feat: x').ok).toBe(true);
    expect(trailer(r)).toBe('');
    expect(readdirSync(r.home).flatMap((d) => readdirSync(join(r.home, d)))).not.toContain('gate.jsonl');
  });

  it('report sums methods, would-blocks, overrides and escapes', () => {
    const r = setup('observe');
    r.write('src/app.js', 'a\n');
    commit(r, 'feat: a');
    r.write('src/app.js', 'b\n');
    commit(r, 'feat: b\n\nVerify-Skip: spike\n');
    r.write('docs/x.md', 'd\n');
    commit(r, 'docs: x');
    const out = r.vlite(['gate', 'report', '--days', '1']).out;
    expect(out).toContain('Commits judged: 3');
    expect(out).toContain('none: 1');
    expect(out).toContain('skipped: 1');
    expect(out).toContain('docs: 1');
    expect(out).toContain('Would have been blocked (observe): 1');
    expect(out).toContain('Checked after commit (same files passed later): 0');
    expect(out).toContain('Overrides (Verify-Skip): 1');
    expect(out).toContain('spike');
  });
});

describe('report: checked after commit', () => {
  const stopHook = (r: Repo): string => JSON.stringify({ session_id: 's1', cwd: r.dir, stop_hook_active: false });
  const stampsFile = (r: Repo): string => {
    const [name] = readdirSync(r.home);
    return join(r.home, name ?? '', 'stamps.jsonl');
  };
  const count = (r: Repo): string => /Checked after commit.*: (\d+)/.exec(r.vlite(['gate', 'report', '--days', '1']).out)?.[1] ?? 'missing';

  it('counts a none commit whose tree passed later, not one with no later pass', () => {
    const r = setup('observe');
    r.write('src/app.js', 'one\n');
    commit(r, 'feat: one');
    expect(trailer(r)).toBe('none');
    r.write('src/app.js', 'two\n');
    commit(r, 'feat: two');
    expect(count(r)).toBe('0');
    r.write('src/app.js', 'one\n'); // work tree is back to commit one's files
    expect(r.vlite(['stop-check'], { input: stopHook(r) }).code).toBe(0);
    expect(count(r)).toBe('1');
  });

  it('a later fail stamp for the same tree cancels the pass', () => {
    const r = setup('observe');
    r.write('src/app.js', 'one\n');
    commit(r, 'feat: one');
    r.write('src/app.js', 'one\n');
    expect(r.vlite(['stop-check'], { input: stopHook(r) }).code).toBe(0);
    const pass = JSON.parse(readFileSync(stampsFile(r), 'utf8').trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
    expect(count(r)).toBe('1');
    const later = new Date(Date.now() + 1000).toISOString();
    appendFileSync(stampsFile(r), `${JSON.stringify({ ...pass, time: later, result: 'fail' })}\n`);
    expect(count(r)).toBe('0');
  });
});

describe('stop-check proof', () => {
  const stopHook = (r: Repo): string => JSON.stringify({ session_id: 's1', cwd: r.dir, stop_hook_active: false });

  it('a passing stop-check counts as proof for the same staged tree, and not after the tree changes', () => {
    const r = setup('observe');
    r.write('src/app.js', 'changed\n');
    const stop = r.vlite(['stop-check'], { input: stopHook(r) });
    expect(stop.code, stop.err).toBe(0);
    expect(stop.out).toBe('');
    r.write('src/app.js', 'changed again\n');
    expect(commit(r, 'edited after the pass').ok).toBe(true);
    expect(trailer(r)).toBe('none');
    r.write('src/app.js', 'third\n');
    expect(r.vlite(['stop-check'], { input: stopHook(r) }).code).toBe(0);
    expect(commit(r, 'same tree as the pass').ok).toBe(true);
    expect(trailer(r)).toBe('stop-check');
  });

  it('a narrow pass is not commit proof (FINDING-003)', () => {
    const parts = [{ name: 'app', paths: ['src/**', 'tests/**'], checks: [{ name: 'check', run: 'node check.mjs', runFiles: 'node check.mjs {files}', timeoutSec: 60 }] }];
    const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' }, baseConfig({ gate: { mode: 'enforce' }, parts }));
    expect(r.vlite(['install']).code).toBe(0);
    r.write('src/app.js', 'v2\n');
    expect(r.vlite(['stop-check'], { input: stopHook(r) }).code).toBe(0); // full pass
    r.write('tests/test_a.py', 'def test_a():\n    assert True\n    assert 1 == 1\n');
    const narrow = r.vlite(['stop-check'], { input: stopHook(r) });
    expect(narrow.out).toContain('vlite stamp verify');
    const [name] = readdirSync(r.home);
    const stamps = readFileSync(join(r.home, name ?? '', 'stamps.jsonl'), 'utf8').trim().split('\n');
    expect(stamps).toHaveLength(1); // only the full pass wrote a stamp
    const c = commit(r, 'tests changed after a narrow pass');
    expect(c.ok).toBe(false);
  });

  it('joins with verify in the documented order', () => {
    const r = setup('observe');
    r.write('src/app.js', 'both\n');
    expect(r.vlite(['stop-check'], { input: stopHook(r) }).code).toBe(0);
    expect(r.vlite(['stamp', 'verify', '--result', 'pass']).code).toBe(0);
    expect(commit(r, 'both proofs').ok).toBe(true);
    expect(trailer(r)).toBe('verify+stop-check');
  });

  it('writes no stop-check stamp when no check ran', () => {
    const r = setup('observe');
    r.write('tools/run.sh', 'echo hi\n'); // no part covers tools/
    const stop = r.vlite(['stop-check'], { input: stopHook(r) });
    expect(stop.code, stop.err).toBe(0);
    expect(commit(r, 'nothing ran').ok).toBe(true);
    expect(trailer(r)).toBe('none');
  });

  it('rejects vlite stamp stop-check typed by hand', () => {
    const r = setup('observe');
    r.write('src/app.js', 'x\n');
    const out = r.vlite(['stamp', 'stop-check', '--result', 'pass']);
    expect(out.code).toBe(1);
    expect(out.err).toContain('vlite stamp <verify|code-review>');
  });
});
