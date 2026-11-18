import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

export interface Repo {
  dir: string;
  home: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  vlite(args: string[], opts?: { input?: string; env?: Record<string, string> }): { code: number; out: string; err: string };
  commitAll(msg: string): void;
}

/** A throwaway repo: commit on main holds vlite.json (and files), then a feature branch is checked out. */
export function makeRepo(files: Record<string, string> = {}, config?: object): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'vlite-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'vlite-home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, VLITE_HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  delete env['GIT_INDEX_FILE'];
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  for (const [p, t] of Object.entries(files)) write(p, t);
  if (config) write('vlite.json', JSON.stringify(config, null, 2));
  write('README.md', '# test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'feature');
  return {
    dir,
    home,
    git,
    write,
    vlite(args, opts = {}) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        encoding: 'utf8',
        input: opts.input ?? '',
        env: { ...env, ...opts.env },
      });
      return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
    },
    commitAll(msg) {
      git('add', '-A');
      git('commit', '-q', '-m', msg);
    },
  };
}

/** A config whose checks are plain node commands, so they run the same under cmd.exe and sh. */
export function baseConfig(extra: object = {}): object {
  return {
    version: 1,
    base: 'main',
    docs: ['**/*.md', 'docs/**'],
    codeDespiteDocs: ['**/SKILL.md'],
    parts: [
      {
        name: 'app',
        paths: ['src/**', 'tests/**'],
        checks: [{ name: 'check', run: 'node check.mjs', timeoutSec: 60 }],
      },
    ],
    tests: { paths: ['tests/**'], removalsLog: 'TEST-REMOVALS.md' },
    maxRounds: 3,
    gate: { mode: 'observe' },
    ...extra,
  };
}

/** check.mjs fails when src/app.js contains the word BAD, printing a line we can look for. */
export const CHECK_SCRIPT = `import { readFileSync } from 'node:fs';
const src = readFileSync('src/app.js', 'utf8');
if (src.includes('BAD')) { console.log('assertion failed: app is BAD'); process.exit(3); }
console.log('all good');
`;

export function lastJson(text: string): Record<string, unknown> {
  const line = text.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}
