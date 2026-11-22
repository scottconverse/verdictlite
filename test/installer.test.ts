import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from './root.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'install.ps1');
const winOnly = it.runIf(process.platform === 'win32');

function run(cmd: string, args: string[], cwd = ROOT): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function runCmd(cmd: string): { code: number; out: string } {
  const r = spawnSync(`"${cmd}" --help`, { cwd: ROOT, encoding: 'utf8', shell: true });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function install(zip: string, dir: string): { code: number; out: string } {
  return run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ZipPath', zip, '-InstallDir', dir, '-NoPath', '-NoConnect']);
}

describe('install.ps1', () => {
  winOnly('installs from a local zip, and a bad sha256 leaves the old install alone', () => {
    const pack = run(process.execPath, [join(ROOT, 'scripts', 'pack.mjs')]);
    expect(pack.code, pack.out).toBe(0);
    const zip = join(ROOT, 'release', 'verdictlite.zip');
    expect(existsSync(`${zip}.sha256`)).toBe(true);

    const base = tempDir('installer-');
    const dir = join(base, 'app');
    const ok = install(zip, dir);
    expect(ok.code, ok.out).toBe(0);
    const cmd = join(base, 'bin', 'vlite.cmd');
    // Long path on both sides: the temp folder can come as a short 8.3 name (RUNNER~1).
    expect(readFileSync(cmd, 'utf8').toLowerCase()).toContain(realpathSync.native(join(dir, 'dist', 'cli.js')).toLowerCase());
    const help = runCmd(cmd);
    expect(help.code, help.out).toBe(0);
    expect(help.out.split(/\r?\n/)[0]).toContain('VerdictLite');

    // Mark the install, then try a zip whose checksum is wrong.
    writeFileSync(join(dir, 'marker.txt'), 'keep me');
    const badDir = tempDir('installer-bad-');
    const badZip = join(badDir, 'verdictlite.zip');
    writeFileSync(badZip, readFileSync(zip));
    writeFileSync(`${badZip}.sha256`, `${'0'.repeat(64)}  verdictlite.zip\n`);
    const bad = install(badZip, dir);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('SHA-256 does not match');
    expect(readFileSync(join(dir, 'marker.txt'), 'utf8')).toBe('keep me');
    expect(runCmd(cmd).out).toContain('VerdictLite');

    // A good update replaces the folder in the same place.
    const again = install(zip, dir);
    expect(again.code, again.out).toBe(0);
    expect(existsSync(join(dir, 'marker.txt'))).toBe(false);
  }, 90_000);

  winOnly('-PlanOnly prints the steps and changes nothing', () => {
    const dir = join(tempDir('installer-plan-'), 'app');
    const r = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-PlanOnly', '-InstallDir', dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('1. Check Node.js');
    expect(existsSync(dir)).toBe(false);
  }, 30_000);
});

describe('install.ps1 connect on update (finding 003)', () => {
  winOnly('connects on a first install, keeps the connect state on an update, and -Connect forces it', () => {
    const pack = run(process.execPath, [join(ROOT, 'scripts', 'pack.mjs')]);
    expect(pack.code, pack.out).toBe(0);
    const zip = join(ROOT, 'release', 'verdictlite.zip');

    // A temp profile, so vlite connect can never touch the real ~/.claude or ~/.codex.
    const profile = tempDir('installer-profile-');
    mkdirSync(join(profile, '.claude'));
    mkdirSync(join(profile, '.codex'));
    const env = { ...process.env, USERPROFILE: profile, HOME: profile, CODEX_HOME: join(profile, '.codex'), VLITE_HOME: '' };
    const settings = join(profile, '.claude', 'settings.json');
    const hookCount = (): number => (existsSync(settings) ? (JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: { Stop?: unknown[] } }).hooks?.Stop?.length ?? 0 : 0);
    const base = tempDir('installer-connect-');
    const dir = join(base, 'app');
    const go = (...extra: string[]): { code: number; out: string } => {
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ZipPath', zip, '-InstallDir', dir, '-NoPath', ...extra], { cwd: ROOT, encoding: 'utf8', env });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };

    // First install: connects, and says so.
    const first = go();
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain('First install: running vlite connect');
    expect(first.out).toContain('approve the hook');
    expect(hookCount()).toBe(1);

    // The person removes the hook. An update must not put it back.
    rmSync(settings);
    const update = go();
    expect(update.code, update.out).toBe(0);
    expect(update.out).toContain('This is an update');
    expect(update.out).toContain('did not run vlite connect');
    expect(update.out).not.toContain('approve the hook');
    expect(existsSync(settings)).toBe(false);

    // -Connect forces it on an update.
    const forced = go('-Connect');
    expect(forced.code, forced.out).toBe(0);
    expect(forced.out).toContain('-Connect: running vlite connect (this is not a first install)');
    expect(hookCount()).toBe(1);

    // -NoConnect still skips it, and the two switches together are refused.
    rmSync(settings);
    const noConnect = go('-NoConnect').out;
    expect(noConnect).toContain('-NoConnect');
    expect(noConnect).not.toContain('approve the hook');
    expect(existsSync(settings)).toBe(false);
    expect(go('-NoConnect', '-Connect').code).not.toBe(0);
  }, 180_000);
});

describe('install.ps1 first install detection (FINDING-002)', () => {
  winOnly('does not connect when the VerdictLite home or the disconnect marker exists, and -Connect still forces it', () => {
    const pack = run(process.execPath, [join(ROOT, 'scripts', 'pack.mjs')]);
    expect(pack.code, pack.out).toBe(0);
    const zip = join(ROOT, 'release', 'verdictlite.zip');
    const profile = tempDir('installer-first-');
    mkdirSync(join(profile, '.claude'));
    const vhome = join(profile, 'vhome');
    const env = { ...process.env, USERPROFILE: profile, HOME: profile, CODEX_HOME: join(profile, '.codex'), LOCALAPPDATA: join(profile, 'local'), VLITE_HOME: vhome };
    const settings = join(profile, '.claude', 'settings.json');
    // a fresh install folder each time, so only the home folder and the marker can say it is not a first install
    const go = (...extra: string[]): { code: number; out: string } => {
      const dir = join(tempDir('installer-first-app-'), 'app');
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ZipPath', zip, '-InstallDir', dir, '-NoPath', ...extra], { cwd: ROOT, encoding: 'utf8', env });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };

    // The home folder exists (a past install, app folder gone): not a first install.
    mkdirSync(vhome);
    const home = go();
    expect(home.code, home.out).toBe(0);
    expect(home.out).toContain('not a first install');
    expect(home.out).toContain('did not run vlite connect');
    expect(home.out).not.toContain('approve the hook');
    expect(existsSync(settings)).toBe(false);

    // The marker says the person disconnected on purpose.
    writeFileSync(join(vhome, 'connect-off.json'), '{"apps":["claude"]}');
    const marker = go();
    expect(marker.code, marker.out).toBe(0);
    expect(marker.out).toContain('disconnected VerdictLite on purpose');
    expect(existsSync(settings)).toBe(false);

    // -Connect still forces it.
    const forced = go('-Connect');
    expect(forced.code, forced.out).toBe(0);
    expect(forced.out).toContain('-Connect: running vlite connect');
    expect(forced.out).toContain('approve the hook');
    expect(existsSync(settings)).toBe(true);
    expect(existsSync(join(vhome, 'connect-off.json'))).toBe(false); // a plain connect removes the marker
  }, 180_000);
});
