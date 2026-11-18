import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../src/config.js';
import { git, worktreeTree } from '../src/git.js';
import { baseConfig, makeRepo } from './helpers.js';

describe('config', () => {
  it('reads vlite.json from the base ref, not the working tree', () => {
    const r = makeRepo({}, baseConfig({ maxRounds: 5 }));
    r.write('vlite.json', JSON.stringify(baseConfig({ maxRounds: 9 })));
    const loaded = loadConfig(r.dir);
    expect(loaded?.source).toBe('base');
    expect(loaded?.ref).toBe('main');
    expect(loaded?.config.maxRounds).toBe(5);
  });

  it('falls back to the working tree only when the base has no config, and marks the log records', () => {
    const r = makeRepo({ 'check.mjs': 'process.exit(0)\n' });
    r.write('vlite.json', JSON.stringify(baseConfig({ maxRounds: 4 })));
    const loaded = loadConfig(r.dir);
    expect(loaded?.source).toBe('worktree');
    expect(loaded?.config.maxRounds).toBe(4);
    r.write('src/app.js', 'ok\n');
    const out = r.vlite(['stop-check', '--session', 's1']);
    expect(out.code).toBe(0);
    expect(out.err).toContain('bootstrap');
    const [stateFolder] = readdirSync(r.home);
    const log = readFileSync(join(r.home, stateFolder ?? '', 'stop.jsonl'), 'utf8');
    expect(JSON.parse(log.trim()).configSource).toBe('worktree');
  });

  it('returns null with no config anywhere, and every command exits 0 quietly', () => {
    const r = makeRepo();
    expect(loadConfig(r.dir)).toBeNull();
    for (const args of [['stop-check', '--session', 'x'], ['gate', 'pre-commit'], ['gate', 'report'], ['stamp', 'verify', '--result', 'pass'], ['review']]) {
      const out = r.vlite(args);
      expect(out.code, args.join(' ')).toBe(0);
      expect(out.out + out.err).toBe('');
    }
    expect(readdirSync(r.home)).toEqual([]);
  });

  it('gives clear errors for a bad config', () => {
    expect(() => parseConfig('{ nope', 'x')).toThrow(/not valid JSON/);
    const bad = { version: 2, parts: [{ name: 'p', paths: [], checks: [{ name: 'c' }] }], gate: { mode: 'loud' }, maxRounds: 0 };
    let message = '';
    try {
      parseConfig(JSON.stringify(bad), 'vlite.json');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"version" must be 1');
    expect(message).toContain('parts[0].paths must list at least one glob');
    expect(message).toContain('parts[0].checks[0].run must be a non-empty string');
    expect(message).toContain('"gate.mode"');
    expect(message).toContain('"maxRounds"');
  });

  it('fills defaults and accepts a BOM', () => {
    const c = parseConfig(`﻿${JSON.stringify({ version: 1 })}`, 'x');
    expect(c.gate.mode).toBe('observe');
    expect(c.maxRounds).toBe(3);
    expect(c.review.command).toBe('claude');
  });
});

describe('tree id', () => {
  it('covers tracked, modified and untracked files, respects .gitignore and never touches the real index', () => {
    const r = makeRepo({ '.gitignore': 'ignored.txt\n', 'a.txt': 'a\n' });
    const indexPath = join(r.dir, '.git', 'index');
    const before = readFileSync(indexPath);
    const beforeTime = statSync(indexPath).mtimeMs;
    const clean = worktreeTree(r.dir);
    expect(clean).toBe(r.git('rev-parse', 'HEAD^{tree}'));

    r.write('ignored.txt', 'x\n');
    expect(worktreeTree(r.dir)).toBe(clean);

    r.write('new.txt', 'new\n');
    r.write('a.txt', 'changed\n');
    const dirty = worktreeTree(r.dir);
    expect(dirty).not.toBe(clean);
    expect(readFileSync(indexPath).equals(before)).toBe(true);
    expect(statSync(indexPath).mtimeMs).toBe(beforeTime);
    expect(r.git('status', '--porcelain')).toContain('?? new.txt');

    r.git('add', '-A');
    expect(r.git('write-tree')).toBe(dirty);
  });

  it('works in a repo with no commits', () => {
    const r = makeRepo();
    const empty = join(r.dir, 'fresh');
    git(r.dir, ['init', '-q', empty]);
    expect(worktreeTree(empty)).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(empty, '.git', 'index'))).toBe(false);
  });
});
