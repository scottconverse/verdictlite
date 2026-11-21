import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connect, HOOK_TIMEOUT_SEC } from '../src/connect.js';
import { tempDir } from './root.js';

const backups = (dir: string): string[] => readdirSync(dir).filter((f) => f.includes('.vlite-backup-'));
const read = (f: string): any => JSON.parse(readFileSync(f, 'utf8'));
const homes = (): { claudeHome: string; codexHome: string } => ({ claudeHome: tempDir('cn-claude-'), codexHome: tempDir('cn-codex-') });

describe('connect', () => {
  it('creates the files with the Stop hook', () => {
    const h = homes();
    const notes = connect({ ...h, apps: ['claude', 'codex'] });
    for (const f of [join(h.claudeHome, 'settings.json'), join(h.codexHome, 'hooks.json')]) {
      const raw = readFileSync(f, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      const hook = read(f).hooks.Stop[0].hooks[0];
      expect(hook.type).toBe('command');
      expect(hook.timeout).toBe(HOOK_TIMEOUT_SEC);
      expect(HOOK_TIMEOUT_SEC).toBe(3600);
      expect(hook.command).toMatch(/^node ".*cli\.js" stop-check --global$/);
      expect(hook.command).not.toContain('\\');
    }
    expect(notes.join('\n')).toContain('Review hooks');
    expect(backups(h.claudeHome)).toHaveLength(0);
  });

  it('keeps other keys and hooks, and makes a backup', () => {
    const h = homes();
    const file = join(h.claudeHome, 'settings.json');
    const orig = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
    writeFileSync(file, JSON.stringify(orig));
    connect({ ...h, apps: ['claude'] });
    const doc = read(file);
    expect(doc.theme).toBe('dark');
    expect(doc.hooks.PreToolUse).toEqual(orig.hooks.PreToolUse);
    expect(doc.hooks.Stop).toHaveLength(2);
    expect(doc.hooks.Stop[0]).toEqual(orig.hooks.Stop[0]);
    const b = backups(h.claudeHome);
    expect(b).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(h.claudeHome, b[0] as string), 'utf8'))).toEqual(orig);
  });

  it('leaves an existing "vlite stop-check --global" alone', () => {
    const h = homes();
    const file = join(h.claudeHome, 'settings.json');
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'vlite stop-check --global' }] }] } });
    writeFileSync(file, text);
    const notes = connect({ ...h, apps: ['claude'] });
    expect(notes.join('\n')).toContain('already connected');
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(backups(h.claudeHome)).toHaveLength(0);
    // uninstall must not remove the owner's own hook
    connect({ ...h, apps: ['claude'], uninstall: true });
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('does not write a file with bad JSON or a wrong shape', () => {
    const h = homes();
    const file = join(h.claudeHome, 'settings.json');
    writeFileSync(file, '{ not json');
    const notes = connect({ ...h, apps: ['claude'] });
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    expect(notes.join('\n')).toContain('stop-check --global');
    expect(backups(h.claudeHome)).toHaveLength(0);
    const odd = JSON.stringify({ hooks: { Stop: 'x' } });
    writeFileSync(file, odd);
    connect({ ...h, apps: ['claude'] });
    expect(readFileSync(file, 'utf8')).toBe(odd);
  });

  it('skips an app whose folder is missing, and creates nothing', () => {
    const base = tempDir('cn-none-');
    const h = { claudeHome: join(base, '.claude'), codexHome: join(base, '.codex') };
    const notes = connect({ ...h, apps: ['claude', 'codex'] });
    expect(notes).toContain('Claude Code not found');
    expect(notes).toContain('Codex not found');
    expect(existsSync(h.claudeHome)).toBe(false);
    expect(existsSync(h.codexHome)).toBe(false);
  });

  it('skips Codex hooks.json when config.toml already has [hooks]', () => {
    const h = homes();
    mkdirSync(h.codexHome, { recursive: true });
    writeFileSync(join(h.codexHome, 'config.toml'), 'model = "x"\n[[hooks.Stop]]\n');
    const notes = connect({ ...h, apps: ['codex'] });
    expect(existsSync(join(h.codexHome, 'hooks.json'))).toBe(false);
    expect(notes.join('\n')).toContain('by hand');
  });

  it('ignores the [hooks.state.*] trust notes that Codex writes to config.toml', () => {
    const h = homes();
    mkdirSync(h.codexHome, { recursive: true });
    writeFileSync(
      join(h.codexHome, 'config.toml'),
      "model = \"x\"\n[hooks.state.'C:\\Users\\a\\.codex\\hooks.json:stop:0:0']\ntrusted_hash = \"abc\"\n",
    );
    const notes = connect({ ...h, apps: ['codex'] });
    expect(existsSync(join(h.codexHome, 'hooks.json'))).toBe(true);
    expect(notes.join('\n')).not.toContain('by hand');
  });

  it('uninstall removes only our handlers (dist/cli.js) and tidies empty groups', () => {
    const h = homes();
    const file = join(h.codexHome, 'hooks.json');
    const keep = { hooks: [{ type: 'command', command: 'echo keep' }] };
    const owner = { hooks: [{ type: 'command', command: 'vlite stop-check --global' }] };
    const ours = { hooks: [{ type: 'command', command: 'node "C:/x/VerdictLite/app/dist/cli.js" stop-check --global', timeout: 2400 }] };
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [keep, owner, ours] } }));
    connect({ ...h, apps: ['codex'], uninstall: true });
    expect(read(file).hooks.Stop).toEqual([keep, owner]);
    expect(backups(h.codexHome)).toHaveLength(1);
    // only ours: Stop and hooks go away, other keys stay
    writeFileSync(file, JSON.stringify({ x: 1, hooks: { Stop: [ours] } }));
    connect({ ...h, apps: ['codex'], uninstall: true });
    expect(read(file)).toEqual({ x: 1 });
  });
});

describe('connect repair (finding 007)', () => {
  it('updates our own entry when its command or timeout is stale, with a backup, and says so', () => {
    const h = homes();
    const file = join(h.claudeHome, 'settings.json');
    const other = { hooks: [{ type: 'command', command: 'echo keep' }] };
    const stale = { hooks: [{ type: 'command', command: 'node "C:/moved/gone/dist/cli.js" stop-check --global', timeout: 2400 }] };
    writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: { Stop: [other, stale] } }));
    const notes = connect({ ...h, apps: ['claude'] }).join('\n');
    expect(notes).toContain('updated the VerdictLite hook');
    expect(notes).toContain('C:/moved/gone/dist/cli.js');
    const doc = read(file);
    expect(doc.theme).toBe('dark');
    expect(doc.hooks.Stop[0]).toEqual(other);
    const hook = doc.hooks.Stop[1].hooks[0];
    expect(hook.command).toMatch(/^node ".*cli\.js" stop-check --global$/);
    expect(hook.command).not.toContain('C:/moved/gone');
    expect(hook.timeout).toBe(HOOK_TIMEOUT_SEC);
    const b = backups(h.claudeHome);
    expect(b).toHaveLength(1);
    expect(read(join(h.claudeHome, b[0] as string)).hooks.Stop[1].hooks[0].command).toContain('C:/moved/gone');
  });

  it('after a repair it reports "already connected" without another backup', () => {
    const h = homes();
    const file = join(h.claudeHome, 'settings.json');
    const stale = { hooks: [{ type: 'command', command: 'node "C:/old/dist/cli.js" stop-check --global', timeout: HOOK_TIMEOUT_SEC }] };
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [stale] } }));
    expect(connect({ ...h, apps: ['claude'] }).join('\n')).toContain('updated the VerdictLite hook');
    expect(read(file).hooks.Stop[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_SEC);
    expect(backups(h.claudeHome)).toHaveLength(1);
    const before = readFileSync(file, 'utf8');
    expect(connect({ ...h, apps: ['claude'] }).join('\n')).toContain('already connected');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(backups(h.claudeHome)).toHaveLength(1);
  });

  it('leaves a custom command that is not ours untouched', () => {
    const h = homes();
    const file = join(h.claudeHome, 'settings.json');
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-tool stop-check --global', timeout: 10 }] }] } });
    writeFileSync(file, text);
    expect(connect({ ...h, apps: ['claude'] }).join('\n')).toContain('already connected');
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(backups(h.claudeHome)).toHaveLength(0);
  });
});
