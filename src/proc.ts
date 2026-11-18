import { spawn, spawnSync } from 'node:child_process';

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  output: string;
  seconds: number;
}

const MAX_OUTPUT = 2 * 1024 * 1024;

/** Runs a command line through the shell, with a timeout that kills the whole process tree. */
export function runShell(command: string, cwd: string, timeoutSec: number, input?: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      ...(env ? { env } : {}),
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group, so a timeout can kill grandchildren
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let done = false;
    const add = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ code, timedOut, output, seconds: (Date.now() - started) / 1000 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // A grandchild can hold the pipes open; do not wait for it forever.
      setTimeout(() => finish(null), 5000).unref();
    }, timeoutSec * 1000);
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.stdin.on('error', () => undefined); // the command may not read its input
    child.on('error', (e) => {
      output += `\n${e.message}\n`;
      finish(127);
    });
    child.on('close', (code) => finish(timedOut ? null : code));
    child.stdin.end(input ?? '');
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export function lastLines(text: string, n: number): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

/** Quotes one argument for a shell command line (cmd.exe or sh). */
export function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_\-.,:/=@+\\]+$/.test(arg)) return arg;
  if (process.platform === 'win32') return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
