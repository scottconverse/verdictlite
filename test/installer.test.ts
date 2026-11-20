import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
