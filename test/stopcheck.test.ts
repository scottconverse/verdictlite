import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseConfig, CHECK_SCRIPT, lastJson, makeRepo, type Repo } from './helpers.js';
import { tempDir } from './root.js';

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
    const message = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['systemMessage']);
    expect(message).toContain('part "mod:gamma" was skipped');
    expect(message).toContain('did NOT run');
    expect(message).toContain('tests/gamma');
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

describe('stop-check timeouts (finding 001)', () => {
  const hang = { name: 'slow', paths: ['src/**'], checks: [{ name: 'hang', run: 'node -e "setInterval(()=>{},1000)"', timeoutSec: 1 }] };

  it('a check that times out is no result: no round, no block, no handoff, no pass, and a warning', () => {
    const r = setup({ maxRounds: 2, parts: [hang] });
    r.write('src/app.js', 'x\n');
    for (let i = 0; i < 3; i++) {
      const json = lastJson(r.vlite(['stop-check', '--session', 's']).out);
      expect(json['decision']).toBeUndefined();
      expect(json['continue']).toBeUndefined();
      const message = String(json['systemMessage']);
      expect(message).toContain('slow/hang froze');
      expect(message).toContain('result is unknown');
      expect(message).toContain('You can continue');
    }
    expect(stopLog(r).map((x) => x['result'])).toEqual(['no-result', 'no-result', 'no-result']);
    expect(stopLog(r).at(-1)).toMatchObject({ timedOut: ['slow/hang'] });
    const stateFile = join(stateFolder(r), 'state.json');
    const state = (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { rounds: {} }) as Record<string, unknown>;
    expect(state['rounds']).toEqual({});
    expect(state['lastPassTree']).toBeUndefined();
    expect(state['partPassTree']).toBeUndefined();
    expect(existsSync(join(stateFolder(r), 'stamps.jsonl'))).toBe(false);
    expect(existsSync(join(stateFolder(r), 'handoffs'))).toBe(false);
  }, 60_000);

  it('a timeout next to a real failure: blocks and hands off on the real failure only, with the timeout warning', () => {
    const r = setup({
      maxRounds: 2,
      parts: [hang, { name: 'app', paths: ['src/**'], checks: [{ name: 'check', run: 'node check.mjs', timeoutSec: 60 }] }],
    });
    r.write('src/app.js', 'BAD\n');
    const one = lastJson(r.vlite(['stop-check', '--session', 's']).out);
    expect(one['decision']).toBe('block');
    const reason = String(one['reason']);
    expect(reason).toContain('[app/check] failed');
    expect(reason).not.toContain('[slow/hang] failed');
    expect(reason).toContain('slow/hang froze');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'block', round: 1, failing: ['app/check'] });
    const two = lastJson(r.vlite(['stop-check', '--session', 's']).out);
    expect(two['continue']).toBe(false);
    const stopReason = String(two['stopReason']);
    expect(stopReason).toContain('app/check still fails after 2 rounds');
    expect(stopReason).not.toContain('timed out');
    expect(stopReason).toContain('slow/hang froze');
  }, 60_000);
});

describe('stop-check requires (finding 004)', () => {
  const parts = [{ name: 'app', paths: ['src/**'], requires: ['needed.txt'], checks: [{ name: 'check', run: 'node check.mjs', timeoutSec: 60 }] }];

  it('deleting a required path that the base branch has is a failure, not a skip', () => {
    const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'BAD\n', 'needed.txt': 'x\n' }, baseConfig({ parts }));
    r.write('src/app.js', 'BAD two\n');
    rmSync(join(r.dir, 'needed.txt'));
    const json = lastJson(r.vlite(['stop-check', '--session', 's']).out);
    expect(json['decision']).toBe('block');
    const reason = String(json['reason']);
    expect(reason).toContain('[app/requires] failed');
    expect(reason).toContain('deleted a required path: needed.txt');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'block', failing: ['app/requires'] });
    expect(existsSync(join(stateFolder(r), 'stamps.jsonl'))).toBe(false);
  });

  it('a required path that the base never had skips the part, with a visible warning and no stamp', () => {
    const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n' }, baseConfig({ parts }));
    r.write('src/app.js', 'BAD\n');
    const json = lastJson(r.vlite(['stop-check', '--session', 's']).out);
    expect(json['decision']).toBeUndefined();
    const message = String(json['systemMessage']);
    expect(message).toContain('part "app" was skipped');
    expect(message).toContain('needed.txt');
    expect(message).toContain('did NOT run');
    expect(stopLog(r).at(-1)).toMatchObject({ result: 'pass', skipped: { app: 'requires missing: needed.txt' } });
    expect(existsSync(join(stateFolder(r), 'stamps.jsonl'))).toBe(false);
  });
});

describe('stop-check skipped parts are not a pass (FINDING-001)', () => {
  const parts = [{ name: 'app', paths: ['src/**'], requires: ['needed.txt'], checks: [{ name: 'check', run: 'node check.mjs', timeoutSec: 60 }] }];
  const sj = (r: Repo): Record<string, any> => JSON.parse(readFileSync(join(stateFolder(r), 'state.json'), 'utf8')) as Record<string, any>;

  it('repeats the warning at each stop, and judges the skipped files once the part can run', () => {
    const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n' }, baseConfig({ parts }));
    r.write('src/app.js', 'BAD\n');
    const first = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['systemMessage']);
    expect(first).toContain('did NOT run');
    expect(sj(r)['lastPassTree']).toBeUndefined();
    expect(sj(r)['skippedPass']).toBeDefined();
    // stop 2, same files: the same warning again, not a silent pass
    const second = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['systemMessage']);
    expect(second).toBe(first);
    expect(stopLog(r)).toHaveLength(1); // answered from state, checks were not rerun
    // stop 3: the required path now exists and the bad code is still there
    r.write('needed.txt', 'x\n');
    const third = lastJson(r.vlite(['stop-check', '--session', 's']).out);
    expect(third['decision']).toBe('block');
    expect(existsSync(join(stateFolder(r), 'stamps.jsonl'))).toBe(false);
  });

  it('a real full pass clears the skipped record', () => {
    const r = makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n' }, baseConfig({ parts }));
    r.write('src/app.js', 'ok\n');
    r.vlite(['stop-check', '--session', 's']);
    r.write('needed.txt', 'x\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    expect(sj(r)['skippedPass']).toEqual({});
    expect(sj(r)['lastPassTree']).toBeDefined();
  });

  it('too many modules repeats the warning and never records a pass', () => {
    const r = makeRepo(
      { 'check.mjs': CHECK_SCRIPT, 'pkg/alpha/x.py': 'a\n', 'pkg/beta/y.py': 'b\n', 'pkg/gamma/z.py': 'c\n' },
      baseConfig({ maxExpandedParts: 2, parts: [{ name: 'mod:{name}', paths: ['pkg/{name}/**'], checks: [{ name: 'tests', run: 'node check.mjs', timeoutSec: 60 }] }] }),
    );
    for (const m of ['alpha', 'beta', 'gamma']) r.write(`pkg/${m}/new.py`, 'x\n');
    const first = String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['systemMessage']);
    expect(first).toContain('3 modules changed');
    expect(String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['systemMessage'])).toBe(first);
    expect(sj(r)['lastPassTree']).toBeUndefined();
  });
});

describe('stop-check rounds (finding 008)', () => {
  const flag = (n: string): string => `node -e "process.exit(require('fs').existsSync('${n}')?1:0)"`;
  const parts = [
    { name: 'one', paths: ['**'], checks: [{ name: 'c', run: flag('F1'), timeoutSec: 60 }] },
    { name: 'two', paths: ['**'], checks: [{ name: 'c', run: flag('F2'), timeoutSec: 60 }] },
  ];

  it('failures that take turns still hand off at maxRounds, and a handoff starts again at round 1', () => {
    const r = setup({ parts });
    const turn = (on: string, off: string): Record<string, unknown> => {
      rmSync(join(r.dir, off), { force: true });
      r.write(on, 'x\n');
      return lastJson(r.vlite(['stop-check', '--session', 's']).out);
    };
    expect(String(turn('F1', 'F2')['reason'])).toContain('Round 1 of 3');
    expect(String(turn('F2', 'F1')['reason'])).toContain('Round 2 of 3');
    const third = turn('F1', 'F2');
    expect(third['continue']).toBe(false);
    expect(String(third['stopReason'])).toContain('still fails after 3 rounds');
    expect(stopLog(r).map((x) => x['result'])).toEqual(['block', 'block', 'handoff']);
    expect(String(turn('F2', 'F1')['reason'])).toContain('Round 1 of 3');
  });

  it('a pass clears the rounds, and old-format keys in state.json are ignored and cleared', () => {
    const r = setup({ parts });
    r.write('F1', 'x\n');
    r.vlite(['stop-check', '--session', 's']);
    const file = join(stateFolder(r), 'state.json');
    const state = JSON.parse(readFileSync(file, 'utf8')) as { rounds: Record<string, number> };
    expect(Object.keys(state.rounds)).toEqual(['s|branch:feature']);
    state.rounds['s|one/c,two/c'] = 2; // the old key format: one key per set of failing checks
    writeFileSync(file, JSON.stringify(state));
    expect(String(lastJson(r.vlite(['stop-check', '--session', 's']).out)['reason'])).toContain('Round 2 of 3');
    rmSync(join(r.dir, 'F1'));
    r.write('F3', 'y\n');
    expect(r.vlite(['stop-check', '--session', 's']).out).toBe('');
    expect((JSON.parse(readFileSync(file, 'utf8')) as { rounds: object }).rounds).toEqual({});
  });
});

/** A fake test runner. FULL scans tests/*.py; IDS runs only the ids it is given. FAILME prints a pytest line, WEIRD prints nothing a parser knows, RENAMED exits 5 when given ids. */
const RUNNER = `import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
const [out, mode, ...args] = process.argv.slice(2);
appendFileSync(out, mode + ' ' + args.join(',') + '\\n');
const files = mode === 'FULL' ? readdirSync('tests').filter((f) => f.endsWith('.py')).map((f) => 'tests/' + f) : args;
let bad = false;
for (const a of files) {
  const f = a.split('::')[0];
  const t = readFileSync(f, 'utf8');
  if (t.includes('RENAMED') && mode !== 'FULL') { console.log('no tests ran'); process.exit(5); }
  if (t.includes('WEIRD')) { console.log('something broke'); bad = true; }
  if (t.includes('FAILME')) { console.log('FAILED ' + f + '::test_x - boom'); bad = true; }
}
process.exit(bad ? 1 : 0);
`;

const TEST_OK = 'def test_x():\n    assert True\n';

interface RerunSetup {
  r: Repo;
  runs(): string[];
}

function rerunSetup(withRunFiles = true): RerunSetup {
  const out = join(tempDir('runs-'), 'runs.log').replace(/\\/g, '/');
  const check: Record<string, unknown> = { name: 'tests', run: `node rec.mjs ${out} FULL`, timeoutSec: 60 };
  if (withRunFiles) check['runFiles'] = `node rec.mjs ${out} IDS {files}`;
  const r = makeRepo(
    { 'rec.mjs': RUNNER, 'src/app.js': 'v1\n', 'tests/test_a.py': TEST_OK, 'tests/test_b.py': TEST_OK },
    baseConfig({ parts: [{ name: 'app', paths: ['src/**', 'tests/**'], checks: [check] }], gate: { mode: 'observe' } }),
  );
  return { r, runs: () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').map((l) => l.trimEnd()) : []) };
}

const stopNow = (r: Repo): Record<string, unknown> => {
  const res = r.vlite(['stop-check', '--session', 's']);
  return res.out.trim() ? lastJson(res.out) : {};
};

const stateOf = (r: Repo): Record<string, unknown> => JSON.parse(readFileSync(join(stateFolder(r), 'state.json'), 'utf8')) as Record<string, unknown>;
const stampFile = (r: Repo): string => join(stateFolder(r), 'stamps.jsonl');

describe('rerun only the failed tests', () => {
  const failA = (s: RerunSetup): void => s.r.write('tests/test_a.py', `${TEST_OK}# FAILME\n`);
  const fixA = (s: RerunSetup): void => s.r.write('tests/test_a.py', `${TEST_OK}# fixed\n`);

  it('saves the failed tests, tells the agent the narrow command, then reruns only them', () => {
    const s = rerunSetup();
    failA(s);
    const block = stopNow(s.r);
    expect(block['decision']).toBe('block');
    const reason = String(block['reason']);
    expect(reason).toContain('check the fix by running only this command: node rec.mjs');
    expect(reason).toContain('IDS tests/test_a.py::test_x');
    expect(reason).toContain('Do not run the full test suite; CI runs it.');
    expect(JSON.stringify(stateOf(s.r)['failedTests'])).toContain('tests/test_a.py::test_x');
    fixA(s);
    const warn = stopNow(s.r);
    expect(s.runs()).toEqual(['FULL', 'IDS tests/test_a.py::test_x']);
    expect(String(warn['systemMessage'])).toContain('reran only the tests that failed last time (tests/test_a.py::test_x)');
    expect(String(warn['systemMessage'])).toContain('The full check did NOT run');
    expect(String(warn['systemMessage'])).toContain('vlite stamp verify');
  });

  it('a rerun that still fails is a normal failure with a new round and saved ids', () => {
    const s = rerunSetup();
    failA(s);
    stopNow(s.r);
    s.r.write('tests/test_a.py', `${TEST_OK}# FAILME again\n`);
    const two = stopNow(s.r);
    expect(s.runs()).toEqual(['FULL', 'IDS tests/test_a.py::test_x']);
    const reason = String(two['reason']);
    expect(reason).toContain('Round 2 of 3');
    expect(reason).toContain('Only the tests that failed last time ran: tests/test_a.py::test_x');
    expect(JSON.stringify(stateOf(s.r)['failedTests'])).toContain('tests/test_a.py::test_x');
  });

  it('a pass after a failed-only rerun gives a warning, no stamp, no moved start point, and no rerun on the same tree', () => {
    const s = rerunSetup();
    s.r.write('src/app.js', 'v2\n');
    stopNow(s.r); // a full pass: the start point and a stamp
    const before = stateOf(s.r);
    const stampsBefore = readFileSync(stampFile(s.r), 'utf8');
    failA(s);
    stopNow(s.r);
    fixA(s);
    const first = stopNow(s.r);
    expect(String(first['systemMessage'])).toContain('not proof');
    const st = stateOf(s.r);
    expect(st['lastPassTree']).toEqual(before['lastPassTree']);
    expect(st['lastPassHead']).toEqual(before['lastPassHead']);
    expect(st['partPassTree']).toEqual(before['partPassTree']);
    expect(st['failedTests']).toBeUndefined();
    expect(Object.keys(st['rounds'] as object)).toHaveLength(0);
    expect(readFileSync(stampFile(s.r), 'utf8')).toBe(stampsBefore);
    const count = s.runs().length;
    const again = stopNow(s.r);
    expect(s.runs()).toHaveLength(count); // same tree: nothing reruns
    expect(again['systemMessage']).toBe(first['systemMessage']);
  });

  it('after that warning, a changed tree runs the check in full and a full pass writes the stamp', () => {
    const s = rerunSetup();
    failA(s);
    stopNow(s.r);
    fixA(s);
    stopNow(s.r);
    s.r.write('src/app.js', 'v2\n');
    const res = stopNow(s.r);
    expect(s.runs().at(-1)).toBe('FULL');
    expect(res['systemMessage']).toBeUndefined();
    expect(stateOf(s.r)['lastPassTree']).toBeDefined();
    expect(readFileSync(stampFile(s.r), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('records nothing when the output is not a known format, so the next stop runs in full', () => {
    const s = rerunSetup();
    s.r.write('tests/test_a.py', `${TEST_OK}# WEIRD\n`);
    const block = stopNow(s.r);
    expect(String(block['reason'])).not.toContain('running only this command');
    expect(stateOf(s.r)['failedTests']).toBeUndefined();
    s.r.write('tests/test_a.py', `${TEST_OK}# WEIRD2\n`);
    stopNow(s.r);
    expect(s.runs()).toEqual(['FULL', 'FULL']);
  });

  it('a failed rerun that names no test (exit 5) runs the full check in the same stop', () => {
    const s = rerunSetup();
    failA(s);
    stopNow(s.r);
    s.r.write('tests/test_a.py', `${TEST_OK}# RENAMED\n`);
    const res = stopNow(s.r);
    expect(s.runs()).toEqual(['FULL', 'IDS tests/test_a.py::test_x', 'FULL']);
    expect(String(res['systemMessage'])).toContain('without naming a failed test, so it ran in full');
    expect(stateOf(s.r)['failedTests']).toBeUndefined();
    expect(stateOf(s.r)['lastPassTree']).toBeDefined(); // the full result counts: a real pass
  });

  it('runs in full when a saved test file is gone', () => {
    const s = rerunSetup();
    failA(s);
    stopNow(s.r);
    rmSync(join(s.r.dir, 'tests/test_a.py'));
    stopNow(s.r);
    expect(s.runs()).toEqual(['FULL', 'FULL']);
  });

  it('a check with no runFiles is unchanged: nothing saved, always full', () => {
    const s = rerunSetup(false);
    failA(s);
    const block = stopNow(s.r);
    expect(String(block['reason'])).not.toContain('running only this command');
    expect(stateOf(s.r)['failedTests']).toBeUndefined();
    fixA(s);
    stopNow(s.r);
    expect(s.runs()).toEqual(['FULL', 'FULL']);
  });

  it('the existing narrow mode still runs only the changed test files', () => {
    const s = rerunSetup();
    s.r.write('src/app.js', 'v2\n');
    stopNow(s.r);
    s.r.write('tests/test_b.py', `${TEST_OK}# edited\n`);
    const res = stopNow(s.r);
    expect(s.runs()).toEqual(['FULL', 'IDS tests/test_b.py']);
    expect(String(res['systemMessage'])).toContain('ran only the changed test files (tests/test_b.py)');
  });
});
