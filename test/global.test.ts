import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseConfig, CHECK_SCRIPT, lastJson, makeRepo, type Repo } from './helpers.js';
import { tempDir } from './root.js';

function setup(): Repo {
  return makeRepo({ 'check.mjs': CHECK_SCRIPT, 'src/app.js': 'fine\n' }, baseConfig());
}

/** A transcript: the person's prompt, then edits by the agent to these files. */
function transcript(edits: string[], opts: { editsBeforePrompt?: string[] } = {}): string {
  const line = (o: object): string => JSON.stringify(o);
  const edit = (p: string): string =>
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: p } }] } });
  const lines = [
    ...(opts.editsBeforePrompt ?? []).map(edit),
    line({ type: 'user', message: { content: 'please change the app' } }),
    ...edits.map(edit),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  ];
  const file = join(tempDir('tx-'), 't.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** Hook input for a session that started in a folder that is not a repo. */
function hook(tx: string, cwd = tempDir('cwd-'), session = 'g1'): string {
  return JSON.stringify({ session_id: session, cwd, transcript_path: tx, stop_hook_active: false });
}

describe('stop-check --global (user-level hook)', () => {
  it('checks the repo a session edited when the session started outside it', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const out = r.vlite(['stop-check', '--global'], { input: hook(transcript([join(r.dir, 'src', 'app.js')])) });
    expect(out.code).toBe(0);
    const j = lastJson(out.out);
    expect(j['decision']).toBe('block');
    expect(String(j['reason'])).toContain('assertion failed: app is BAD');
  });

  it('passes silently when the edited repo is fine', () => {
    const r = setup();
    r.write('src/app.js', 'still fine\n');
    const out = r.vlite(['stop-check', '--global'], { input: hook(transcript([join(r.dir, 'src', 'app.js')])) });
    expect(out.out).toBe('');
  });

  it('does nothing in a folder or repo without vlite.json', () => {
    const other = makeRepo({ 'a.txt': 'x\n' }); // no config
    other.write('a.txt', 'changed\n');
    const out = other.vlite(['stop-check', '--global'], {
      input: hook(transcript([join(other.dir, 'a.txt')]), other.dir),
    });
    expect(out.code).toBe(0);
    expect(out.out).toBe('');
    expect(out.err).toBe('');
    expect(readdirSync(other.home)).toEqual([]); // no state written
  });

  it('ignores edits made before the last prompt', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const tx = transcript([], { editsBeforePrompt: [join(r.dir, 'src', 'app.js')] });
    expect(r.vlite(['stop-check', '--global'], { input: hook(tx) }).out).toBe('');
  });

  it('leaves the session folder repo to its project hook (no double run)', () => {
    const r = setup();
    r.write('.claude/settings.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"vlite stop-check"}]}]}}');
    r.commitAll('project hook');
    r.write('src/app.js', 'BAD\n');
    const g = r.vlite(['stop-check', '--global'], { input: hook(transcript([join(r.dir, 'src', 'app.js')]), r.dir) });
    expect(g.out).toBe('');
    // the project hook itself still blocks
    const p = r.vlite(['stop-check'], { input: JSON.stringify({ session_id: 'g1', cwd: r.dir }) });
    expect(lastJson(p.out)['decision']).toBe('block');
  });

  it('checks the session folder repo when it has no project hook', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const out = r.vlite(['stop-check', '--global'], { input: hook(transcript([]), r.dir) });
    expect(lastJson(out.out)['decision']).toBe('block');
  });

  it('checks the opened repo in Codex even when a Claude project hook exists', () => {
    const r = setup();
    r.write('.claude/settings.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"vlite stop-check"}]}]}}');
    r.commitAll('project hook');
    r.write('src/app.js', 'BAD\n');
    const out = r.vlite(['stop-check', '--global', '--codex'], { input: hook(transcript([join(r.dir, 'src', 'app.js')]), r.dir) });
    expect(out.code).toBe(0);
    const j = lastJson(out.out);
    expect(j['decision']).toBe('block');
    expect(String(j['reason'])).toContain('assertion failed: app is BAD');
  });

  it('re-checks a blocked repo on the next stop even after a new prompt line', () => {
    const r = setup();
    r.write('src/app.js', 'BAD\n');
    const cwd = tempDir('cwd-');
    const first = r.vlite(['stop-check', '--global'], { input: hook(transcript([join(r.dir, 'src', 'app.js')]), cwd) });
    expect(lastJson(first.out)['decision']).toBe('block');
    // The next transcript shows no edit after the newest prompt line, but the repo still fails.
    const second = r.vlite(['stop-check', '--global'], { input: hook(transcript([]), cwd) });
    expect(lastJson(second.out)['decision']).toBe('block');
    r.write('src/app.js', 'fixed\n');
    const third = r.vlite(['stop-check', '--global'], { input: hook(transcript([]), cwd) });
    expect(third.out).toBe('');
    expect(existsSync(join(r.home, 'sessions', 'g1.json'))).toBe(false);
  });
});
