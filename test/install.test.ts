import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseConfig, makeRepo } from './helpers.js';

describe('install', () => {
  it('writes both hooks, is idempotent, and uninstall removes them', () => {
    const r = makeRepo({}, baseConfig());
    const hooks = join(r.dir, '.git', 'hooks');
    expect(r.vlite(['install']).code).toBe(0);
    const pre = readFileSync(join(hooks, 'pre-commit'), 'utf8');
    expect(pre).toContain('gate pre-commit');
    expect(readFileSync(join(hooks, 'commit-msg'), 'utf8')).toContain('gate commit-msg "$1"');
    expect(r.vlite(['install']).out).toContain('updated');
    expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toBe(pre);
    expect(existsSync(join(hooks, 'pre-commit.vlite-prev'))).toBe(false);
    r.vlite(['install', '--uninstall']);
    expect(existsSync(join(hooks, 'pre-commit'))).toBe(false);
    expect(existsSync(join(hooks, 'commit-msg'))).toBe(false);
  });

  it('chains a foreign hook first, keeps its exit code, and uninstall restores it', () => {
    const r = makeRepo({ 'src/a.js': 'a\n' }, baseConfig());
    const hooks = join(r.dir, '.git', 'hooks');
    const foreign = '#!/bin/sh\necho foreign-ran >> "$(git rev-parse --git-dir)/foreign.log"\nif [ -f STOP ]; then exit 7; fi\n';
    writeFileSync(join(hooks, 'pre-commit'), foreign, { mode: 0o755 });
    expect(r.vlite(['install']).out).toContain('vlite-prev');
    expect(r.vlite(['install']).code).toBe(0); // second run must not move our own hook onto the foreign one
    expect(readFileSync(join(hooks, 'pre-commit.vlite-prev'), 'utf8')).toBe(foreign);

    r.write('src/a.js', 'b\n');
    r.commitAll('feat: b');
    expect(readFileSync(join(r.dir, '.git', 'foreign.log'), 'utf8')).toContain('foreign-ran');
    expect(r.git('log', '-1', '--format=%B')).toContain('Verified-By: none');

    r.write('STOP', '');
    r.git('add', '-A');
    let failed = false;
    try {
      r.git('commit', '-q', '-m', 'blocked by foreign hook');
    } catch (e) {
      failed = true;
      expect((e as Error).message).not.toContain('VerdictLite');
    }
    expect(failed).toBe(true);

    r.vlite(['install', '--uninstall']);
    expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toBe(foreign);
    expect(existsSync(join(hooks, 'pre-commit.vlite-prev'))).toBe(false);
  });

  it('respects core.hooksPath', () => {
    const r = makeRepo({}, baseConfig());
    r.git('config', 'core.hooksPath', 'my-hooks');
    expect(r.vlite(['install']).code).toBe(0);
    expect(existsSync(join(r.dir, 'my-hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(r.dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('--claude prints the Stop hook snippet and writes nothing', () => {
    const r = makeRepo({}, baseConfig());
    const out = r.vlite(['install', '--claude']).out;
    expect(out).toContain('"Stop"');
    expect(out).toContain('vlite stop-check');
    expect(existsSync(join(r.dir, '.claude'))).toBe(false);
  });
});
