import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseConfig, CHECK_SCRIPT, lastJson, makeRepo, type Repo } from './helpers.js';

function setup(extra: object = {}): Repo {
  return makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' }, baseConfig(extra));
}

function stateFolder(r: Repo): string {
  const [name] = readdirSync(r.home);
  return join(r.home, name ?? '');
}

function stopLog(r: Repo): Record<string, unknown>[] {
  return readFileSync(join(stateFolder(r), 'stop.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const hook = (r: Repo, session = 's1'): string => JSON.stringify({ session_id: session, cwd: r.dir, stop_hook_active: false });

describe('stop-check', () => {
  it('does nothing in a reviewer session (VLITE_REVIEWER=1), but blocks the same repo without it', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const skipped = r.vlite(['stop-check'], { input: hook(r), env: { VLITE_REVIEWER: '1' } });
    expect(skipped.code).toBe(0);
    expect(skipped.out).toBe('');
    const blocked = r.vlite(['stop-check'], { input: hook(r), env: { VLITE_REVIEWER: '' } });
    expect(blocked.code).toBe(0);
    expect(lastJson(blocked.out)['decision']).toBe('block');
  });

  it('passes a good change, records the tree, and is silent on the same tree', () => {
    const r = setup();
    r.write('src/app.js', 'still fine\n');
    const first = r.vlite(['stop-check'], { input: hook(r) });
    expect(first.code).toBe(0);
    expect(first.out).toBe('');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'pass', ran: ['app/check'], session: 's1' });
    const again = r.vlite(['stop-check'], { input: hook(r) });
    expect(again.out).toBe('');
    expect(stopLog(r)).toHaveLength(1); // unchanged tree: no work, no record
  });

  it('blocks a failing check with command, exit code and output, then hands off at round 3', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const one = r.vlite(['stop-check'], { input: hook(r) });
    expect(one.code).toBe(0);
    const block = lastJson(one.out);
    expect(block['decision']).toBe('block');
    const reason = String(block['reason']);
    expect(reason).toContain('[app/check] failed');
    expect(reason).toContain('node check.mjs');
    expect(reason).toContain('exit code 3');
    expect(reason).toContain('assertion failed: app is BAD');
    expect(reason).toContain('Round 1 of 3. Fix the cause. Do not skip, sleep or rerun to pass.');

    const two = lastJson(r.vlite(['stop-check'], { input: hook(r) }).out);
    expect(String(two['reason'])).toContain('Round 2 of 3');

    const three = lastJson(r.vlite(['stop-check'], { input: hook(r) }).out);
    expect(three['decision']).toBeUndefined();
    expect(three['continue']).toBe(false);
    const stopReason = String(three['stopReason']);
    expect(stopReason).toContain('VerdictLite: app/check still fails after 3 rounds. A person must look.');
    const handoff = /Handoff: (.+)$/.exec(stopReason)?.[1] ?? '';
    expect(existsSync(handoff)).toBe(true);
    expect(readFileSync(handoff, 'utf8')).toContain('assertion failed: app is BAD');
    expect(stopLog(r).map((x) => x['result'])).toEqual(['block', 'block', 'handoff']);
  });

  it('counts rounds per session, and a pass resets them', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    r.vlite(['stop-check'], { input: hook(r, 'a') });
    r.vlite(['stop-check'], { input: hook(r, 'a') });
    expect(String(lastJson(r.vlite(['stop-check'], { input: hook(r, 'b') }).out)['reason'])).toContain('Round 1 of 3');
    r.write('src/app.js', 'fixed\n');
    expect(r.vlite(['stop-check'], { input: hook(r, 'a') }).out).toBe('');
    r.write('src/app.js', 'BAD again\n');
    expect(String(lastJson(r.vlite(['stop-check'], { input: hook(r, 'a') }).out)['reason'])).toContain('Round 1 of 3');
  });

  it('passes a docs-only change without running checks', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    r.commitAll('bad code on the branch');
    r.write('src/app.js', 'fine\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    r.write('docs/guide.md', 'words\n');
    r.write('NOTES.md', 'more words\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'pass', docsOnly: true });
  });

  it('a file listed in codeDespiteDocs is code', () => {
    const r = setup({ parts: [{ name: 'skills', paths: ['**/SKILL.md'], checks: [{ name: 'lint', run: 'node -e "process.exit(4)"' }] }] });
    r.write('skills/x/SKILL.md', 'do things\n');
    expect(lastJson(r.vlite(['stop-check', '--session', 's']).out)['decision']).toBe('block');
  });

  it('runs only parts whose paths match, and other parts still run after a failure', () => {
    const r = setup({
      parts: [
        { name: 'one', paths: ['src/**'], checks: [{ name: 'fail', run: 'node -e "process.exit(5)"' }, { name: 'never', run: 'node -e "process.exit(6)"' }] },
        { name: 'two', paths: ['src/**'], checks: [{ name: 'ok', run: 'node -e "0"' }] },
        { name: 'other', paths: ['lib/**'], checks: [{ name: 'x', run: 'node -e "process.exit(7)"' }] },
      ],
    });
    r.write('src/app.js', 'x\n');
    const reason = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['reason']);
    expect(reason).toContain('[one/fail]');
    expect(reason).not.toContain('one/never');
    expect(reason).not.toContain('other/x');
    expect(stopLog(r).at(-1)?.['ran']).toEqual(['one/fail', 'two/ok']);
  });

  it('fails a check that times out', () => {
    const r = setup({ parts: [{ name: 'slow', paths: ['src/**'], checks: [{ name: 'hang', run: 'node -e "setInterval(()=>{},1000)"', timeoutSec: 1 }] }] });
    r.write('src/app.js', 'x\n');
    const reason = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['reason']);
    expect(reason).toContain('[slow/hang] failed');
    expect(reason).toContain('timed out');
  });

  it('runs the built-in test-tamper check on changed test files', () => {
    const r = setup();
    r.write('tests/test_a.py', 'import pytest\n\n@pytest.mark.skip(reason="later")\ndef test_a():\n    assert True\n');
    const reason = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['reason']);
    expect(reason).toContain('[test-tamper] failed');
    expect(reason).toContain('tests/test_a.py:3 [skip]');
  });

  it('flags a deleted test unless the removals log has it', () => {
    const r = setup();
    r.write('tests/test_a.py', '# emptied\n');
    expect(String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['reason'])).toContain('[removed-test]');
    r.write('TEST-REMOVALS.md', '- test_a: covered by the new end-to-end test\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
  });

  it('fails open on its own errors (bad config on the base) and logs them', () => {
    const r = makeRepo({ 'vlite.json': '{ "version": 1, "parts": "oops" }' });
    r.write('src/app.js', 'x\n');
    const out = r.vlite(['stop-check'], { input: hook(r) });
    expect(out.code).toBe(0);
    expect(String(lastJson(out.out)['systemMessage'])).toContain('Checks did NOT run');
    expect(out.err).toContain('internal error');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'error' });
  });

  it('accepts empty stdin when run by hand', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const out = r.vlite(['stop-check'], { input: '' });
    expect(lastJson(out.out)['decision']).toBe('block');
    expect(stopLog(r).at(-1)?.['session']).toBe('manual');
  });
});

describe('stop-check with a template part', () => {
  // record.mjs logs the module name it was given to ran-log.txt (git-ignored), and fails when pkg/<name>/FAIL exists.
  const RECORD = `import { appendFileSync, existsSync } from 'node:fs';
const name = process.argv[2];
appendFileSync('ran-log.txt', name + '\\n');
if (existsSync('pkg/' + name + '/FAIL')) { console.log('tests for ' + name + ' failed'); process.exit(2); }
`;
  function templated(extra: object = {}): Repo {
    return makeRepo(
      {
        '.gitignore': 'ran-log.txt\n',
        'record.mjs': RECORD,
        'pkg/alpha/x.py': 'a = 1\n',
        'pkg/beta/y.py': 'b = 1\n',
        'pkg/gamma/z.py': 'c = 1\n',
        'tests/alpha/t.txt': 'alpha tests\n',
        'tests/beta/t.txt': 'beta tests\n',
      },
      {
        version: 1,
        base: 'main',
        docs: ['**/*.md'],
        parts: [
          {
            name: 'mod:{name}',
            paths: ['pkg/{name}/**', 'tests/{name}/**'],
            requires: ['tests/{name}'],
            checks: [{ name: 'tests', run: 'node record.mjs {name}', timeoutSec: 60 }],
          },
        ],
        ...extra,
      },
    );
  }
  const ranLog = (r: Repo): string[] => {
    const file = join(r.dir, 'ran-log.txt');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
  };

  it('runs only the tests of the module that changed, then both when two modules change', () => {
    const r = templated();
    r.write('pkg/alpha/x.py', 'a = 2\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'pass', ran: ['mod:alpha/tests'] });
    expect(ranLog(r)).toEqual(['alpha']);

    r.write('pkg/alpha/x.py', 'a = 3\n');
    r.write('pkg/beta/y.py', 'b = 3\n');
    r.write('tests/beta/t.txt', 'more beta tests\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'pass', ran: ['mod:alpha/tests', 'mod:beta/tests'] });
    expect(ranLog(r)).toEqual(['alpha', 'alpha', 'beta']);
  });

  it('names the expanded part in the block message', () => {
    const r = templated();
    r.write('pkg/beta/FAIL', 'x\n');
    r.write('pkg/alpha/x.py', 'a = 2\n');
    const reason = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['reason']);
    expect(reason).toContain('[mod:beta/tests] failed');
    expect(reason).toContain('command: node record.mjs beta');
    expect(reason).toContain('tests for beta failed');
    expect(reason).not.toContain('mod:alpha/tests] failed');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'block', failing: ['mod:beta/tests'], ran: ['mod:alpha/tests', 'mod:beta/tests'] });
  });

  it('skips a module whose required folder is missing and says so in the log', () => {
    const r = templated();
    r.write('pkg/gamma/z.py', 'c = 2\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'pass', ran: [], skipped: { 'mod:gamma': 'requires missing: tests/gamma' } });
    expect(ranLog(r)).toEqual([]);
  });

  it('runs nothing for a folder name that is not a safe name', () => {
    const r = templated();
    const names = ['a;rm -rf x', 'two words', '$HOME', '`id`', 'a&b', "it's", ...(process.platform === 'win32' ? [] : ['a|b', '"q"'])];
    for (const n of names) r.write(`pkg/${n}/y.py`, 'x\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'pass', ran: [], changed: names.length });
    expect(ranLog(r)).toEqual([]);
  });

  it('warns, and does not block, when a template matches too many modules and everything else passes', () => {
    const r = templated({ maxExpandedParts: 2 });
    for (const m of ['alpha', 'beta', 'gamma']) r.write(`pkg/${m}/new.py`, 'x\n');
    const out = r.vlite(['stop-check', '--session', 's']);
    expect(out.code).toBe(0);
    const json = lastJson(out.out);
    expect(json['decision']).toBeUndefined();
    const message = String(json['systemMessage']);
    expect(message).toContain('3 modules changed for "mod:{name}" (limit 2)');
    expect(message).toContain('mod:alpha, mod:beta, mod:gamma');
    expect(message).toContain('Other checks passed');
    expect(ranLog(r)).toEqual([]);
    expect(stopLog(r).at(-1)).toMatchObject({
      result: 'pass',
      skipped: { 'mod:{name}': 'too many modules (3, limit 2): mod:alpha, mod:beta, mod:gamma' },
    });
    expect(existsSync(join(stateFolder(r), 'stamps.jsonl'))).toBe(false);
  });

  it('blocks on another failing part, without listing too-many as a failure, and adds the note', () => {
    const r = makeRepo(
      { 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n', 'pkg/alpha/x.py': 'a\n', 'pkg/beta/y.py': 'b\n', 'pkg/gamma/z.py': 'c\n' },
      baseConfig({
        maxExpandedParts: 2,
        parts: [
          { name: 'app', paths: ['src/**'], checks: [{ name: 'check', run: 'node check.mjs', timeoutSec: 60 }] },
          { name: 'mod:{name}', paths: ['pkg/{name}/**'], checks: [{ name: 'tests', run: 'node check.mjs', timeoutSec: 60 }] },
        ],
      }),
    );
    r.write('src/app.js', 'BAD\n');
    for (const m of ['alpha', 'beta', 'gamma']) r.write(`pkg/${m}/new.py`, 'x\n');
    const reason = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['reason']);
    expect(reason).toContain('[app/check] failed');
    expect(reason).not.toContain('too many parts');
    expect(reason).not.toContain('[mod:{name}');
    expect(reason).toContain('3 modules changed for "mod:{name}" (limit 2)');
    expect(reason.trimEnd().endsWith('or raise maxExpandedParts on the base branch.')).toBe(true);
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'block', failing: ['app/check'] });
  });
});

describe('stop-check on a detached HEAD', () => {
  it('does not use a pass from another detached commit as the start point', () => {
    const r = setup();
    // A worktree detached at an old commit passes; its tree is saved.
    r.git('checkout', '-q', '--detach');
    r.write('src/app.js', 'old fine\n');
    expect(r.vlite(['stop-check'], { input: hook(r) }).out).toBe('');
    // Later, main gets more merged work, and a new worktree is detached at the new tip.
    r.git('checkout', '-q', '-f', 'main');
    r.write('src/merged1.js', 'one\n');
    r.write('src/merged2.js', 'two\n');
    r.commitAll('merged work');
    r.git('checkout', '-q', '--detach');
    r.write('src/app.js', 'worker edit\n');
    expect(r.vlite(['stop-check'], { input: hook(r, 's2') }).out).toBe('');
    const last = stopLog(r).at(-1) ?? {};
    // Only the worker's own edit counts, not the merged files.
    expect(last['changed']).toBe(1);
    expect(last['from']).toBe(r.git('rev-parse', 'main^{tree}'));
  });
});
