import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubOwner } from '../src/settings.js';
import { lastJson, makeRepo, type Repo } from './helpers.js';

describe('githubOwner', () => {
  it.each([
    ['https://github.com/ForkCommons/x.git', 'forkcommons'],
    ['https://github.com/ForkCommons/x', 'forkcommons'],
    ['http://github.com/Acme/x.git', 'acme'],
    ['https://user@github.com/Acme/x.git', 'acme'],
    ['https://user:tok@github.com/Acme/x.git', 'acme'],
    ['git@github.com:Acme/x.git', 'acme'],
    ['git@github.com:Acme/x', 'acme'],
    ['ssh://git@github.com/Acme/x.git', 'acme'],
    ['  https://GitHub.com/Acme/x.git\n', 'acme'],
  ])('%s -> %s', (url, owner) => {
    expect(githubOwner(url)).toBe(owner);
  });
  it.each(['https://gitlab.com/Acme/x.git', 'git@bitbucket.org:Acme/x.git', 'https://github.com.evil.com/Acme/x', '', '/some/local/path', 'https://github.com/Acme'])(
    'not github: %s',
    (url) => {
      expect(githubOwner(url)).toBeNull();
    },
  );
});

const settingsFile = (r: Repo): string => join(r.home, 'settings.json');
const hook = (r: Repo, active = false): string => JSON.stringify({ session_id: 's1', cwd: r.dir, stop_hook_active: active });
const orgRepo = (origin = 'https://github.com/ForkCommons/x.git'): Repo => {
  const r = makeRepo({ 'a.txt': 'x\n' });
  r.git('remote', 'add', 'origin', origin);
  writeFileSync(settingsFile(r), JSON.stringify({ requiredOrgs: ['forkcommons'] }));
  return r;
};

describe('settings file', () => {
  it('missing file means no required orgs', () => {
    const r = makeRepo();
    expect(r.vlite(['require-org', '--list'])).toMatchObject({ code: 0, out: 'No required orgs.\n' });
  });
  it('bad JSON warns and uses defaults', () => {
    const r = makeRepo();
    writeFileSync(settingsFile(r), '{nope');
    const o = r.vlite(['require-org']);
    expect(o.code).toBe(0);
    expect(o.out).toBe('No required orgs.\n');
    expect(o.err).toContain('could not read');
  });
});

describe('require-org command', () => {
  it('adds (lowercase, no duplicates), lists and removes', () => {
    const r = makeRepo();
    expect(r.vlite(['require-org', 'ForkCommons']).code).toBe(0);
    r.vlite(['require-org', 'forkcommons']);
    r.vlite(['require-org', 'Acme']);
    const text = readFileSync(settingsFile(r), 'utf8');
    expect(JSON.parse(text)).toEqual({ requiredOrgs: ['forkcommons', 'acme'] });
    expect(text.endsWith('}\n')).toBe(true);
    expect(r.vlite(['require-org', '--list']).out).toBe('forkcommons\nacme\n');
    expect(r.vlite(['require-org']).out).toBe('forkcommons\nacme\n');
    expect(r.vlite(['require-org', '--remove', 'FORKCOMMONS']).code).toBe(0);
    expect(r.vlite(['require-org']).out).toBe('acme\n');
    expect(r.vlite(['require-org', '--remove', 'nothere']).code).not.toBe(0);
    expect(existsSync(`${settingsFile(r)}.tmp`)).toBe(false);
  });
});

describe('stop-check with a required org', () => {
  it('blocks once for a repo with no vlite.json (global and project paths) and logs it', () => {
    const r = orgRepo();
    for (const args of [['stop-check', '--global'], ['stop-check']]) {
      const j = lastJson(r.vlite(args, { input: hook(r) }).out);
      expect(j['decision']).toBe('block');
      expect(String(j['reason'])).toContain('belongs to the GitHub org "forkcommons"');
      expect(String(j['reason'])).toContain('has no vlite.json yet');
    }
    const dirs = readdirSync(r.home).filter((d) => existsSync(join(r.home, d, 'stop.jsonl')));
    expect(dirs).toHaveLength(1);
    const first = readFileSync(join(r.home, dirs[0] as string, 'stop.jsonl'), 'utf8').trim().split(String.fromCharCode(10))[0] as string;
    const rec = JSON.parse(first) as Record<string, unknown>;
    expect(rec['result']).toBe('missing-config');
    expect(rec['org']).toBe('forkcommons');
  });

  it('warns, does not block, when stop_hook_active is true', () => {
    const r = orgRepo('git@github.com:forkcommons/x.git');
    const j = lastJson(r.vlite(['stop-check', '--global'], { input: hook(r, true) }).out);
    expect(j['decision']).toBeUndefined();
    expect(String(j['systemMessage'])).toContain('still has no vlite.json');
  });

  it('does not block when the org is not listed, or there is no origin, or another host', () => {
    const r = orgRepo('https://github.com/Other/x.git');
    expect(r.vlite(['stop-check', '--global'], { input: hook(r) }).out).toBe('');
    const n = makeRepo({ 'a.txt': 'x\n' });
    writeFileSync(settingsFile(n), JSON.stringify({ requiredOrgs: ['forkcommons'] }));
    expect(n.vlite(['stop-check', '--global'], { input: hook(n) }).out).toBe('');
    const g = orgRepo('https://gitlab.com/forkcommons/x.git');
    expect(g.vlite(['stop-check', '--global'], { input: hook(g) }).out).toBe('');
  });

  it('does not block when vlite.json exists (committed or working tree only)', () => {
    const r = orgRepo();
    r.write('vlite.json', JSON.stringify({ version: 1, parts: [] }));
    const o = r.vlite(['stop-check', '--global'], { input: hook(r) });
    expect(o.out).toBe('');
    r.git('checkout', '-q', 'main');
    r.commitAll('add config');
    expect(r.vlite(['stop-check', '--global'], { input: hook(r) }).out).toBe('');
  });
});
