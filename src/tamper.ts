// Built-in "test-tamper" check: a change must not pass by skipping, sleeping, retrying or deleting tests.
import { matchAny } from './glob.js';

export interface Line {
  line: number;
  text: string;
}

export interface FileDiff {
  path: string;
  added: Line[];
  removed: Line[];
}

export interface Hit {
  file: string;
  line: number;
  kind: 'skip' | 'sleep' | 'retry' | 'removed-test';
  text: string;
  advice: string;
}

/** Parses `git diff -U0` output into added and removed lines per file (new line numbers for added, old for removed). */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let oldPath = '';
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      cur = null;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) oldPath = cleanPath(line.slice(4), 'a/');
      else if (line.startsWith('+++ ')) {
        const newPath = cleanPath(line.slice(4), 'b/');
        cur = { path: newPath === '/dev/null' ? oldPath : newPath, added: [], removed: [] };
        files.push(cur);
      }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (!inHunk || !cur) continue;
    if (line.startsWith('+')) cur.added.push({ line: newNo++, text: line.slice(1) });
    else if (line.startsWith('-')) cur.removed.push({ line: oldNo++, text: line.slice(1) });
    else if (line.startsWith(' ')) {
      oldNo++;
      newNo++;
    }
  }
  return files;
}

function cleanPath(p: string, prefix: string): string {
  let s = p.replace(/\t.*$/, '');
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

const SKIP =
  /pytest\.mark\.(?:skip|xfail)|pytest\.(?:skip|xfail|importorskip)\(|\.skipTest\(|\.skipIf\(|\b(?:it|test|describe)\.only\b|(?<![.\w])f(?:it|describe)\(|@unittest\.(?:skip|expectedFailure)|\bxfail\b|\.skip\(|\b(?:it|test|describe)\.skip\b|\bx(?:it|describe|test)\(|\btest\.fixme\b|\.fixme\(/;
const SLEEP =
  /\btime\.sleep\(|\basyncio\.sleep\(|\bwaitForTimeout\(|new Promise[^\n]*setTimeout|await\s+(?:\w+\.)?setTimeout\(|setTimeout\(\s*(?:r|res|resolve|done|ok)\s*[,)]/;
const RETRY_MARK = /@flaky\b|pytest\.mark\.flaky|--reruns\b|\.retries\(\s*[1-9]|jest\.retryTimes\(/;
const RETRIES_SETTING = /\bretries\s*[:=]/;
const PY_TEST = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/;
const JS_TEST = /\b(?:it|test)(?:\.(?:only|skip|fixme|concurrent))?\s*\(\s*(['"`])((?:(?!\1).)+)\1/;

/** Config files where a raised retry count is also tamper, even when they are not test files. */
export const RETRY_CONFIG_FILES = [
  '**/playwright.config.*',
  '**/vitest.config.*',
  '**/vite.config.*',
  '**/jest.config.*',
  '**/pytest.ini',
  '**/pyproject.toml',
  '**/setup.cfg',
  '**/tox.ini',
  '**/conftest.py',
];

const COND_SKIP = /(?:pytest\.mark\.skipif|\.skipIf|\.skipUnless|\.runIf)\s*\(/;
// The only things a platform guard may test: the OS name, compared with a plain string.
const PLATFORM_TOKENS =
  /sys\.platform(?:\.startswith\(\s*(['"])[\w.-]+\1\s*\))?|os\.name|platform\.system\(\)|process\.platform|(['"])[\w.-]+\2|[=!]==?|\bnot\b|\band\b|\bor\b|&&|\|\||!|[()]|\s+/g;

/**
 * True when the added line starts a conditional skip whose condition is only a platform check, for example
 * `pytest.mark.skipif(os.name != "nt", reason="...")` or `it.skipIf(process.platform !== 'win32')`.
 * A test that runs only on the OS it is for is not tamper. The condition may go on in the next added lines.
 */
function isPlatformGuard(lines: Line[], i: number): boolean {
  const first = lines[i];
  if (!first) return false;
  const start = COND_SKIP.exec(first.text);
  if (!start) return false;
  let text = first.text.slice(start.index + start[0].length);
  for (let j = i + 1; j < lines.length && j <= i + 5 && lines[j]?.line === (lines[j - 1]?.line ?? 0) + 1; j++) text += ` ${lines[j]?.text ?? ''}`;
  // The condition is the first argument: up to the first comma or closing paren at depth 0.
  let depth = 0;
  let end = -1;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) {
        end = k;
        break;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      end = k;
      break;
    }
  }
  if (end < 0) return false;
  const cond = text.slice(0, end);
  if (!/sys\.platform|os\.name|platform\.system\(\)|process\.platform/.test(cond)) return false;
  return cond.replace(PLATFORM_TOKENS, '') === '';
}

function maxNumber(text: string): number {
  const nums = (text.match(/\d+/g) ?? []).map(Number);
  return nums.length ? Math.max(...nums) : 0;
}

/** True when the log names the test as a whole word, so "test_a" is not found inside "test_abc". */
function inLog(log: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`).test(log);
}

export function testName(text: string): string | null {
  const py = PY_TEST.exec(text);
  if (py?.[1]) return py[1];
  const js = JS_TEST.exec(text);
  return js?.[2] ?? null;
}

/**
 * diffs: every file in the change. testGlobs: config tests.paths. removalsLog: the file where a removed test must be written down.
 */
export function detectTamper(diffs: FileDiff[], testGlobs: string[], removalsLog: string): Hit[] {
  const hits: Hit[] = [];
  const addedNames = new Set<string>();
  for (const d of diffs) for (const a of d.added) {
    const n = testName(a.text);
    if (n) addedNames.add(n);
  }
  const logText = diffs
    .filter((d) => d.path === removalsLog)
    .flatMap((d) => d.added.map((a) => a.text))
    .join('\n');

  for (const d of diffs) {
    const isTest = matchAny(testGlobs, d.path);
    const isRetryConfig = matchAny(RETRY_CONFIG_FILES, d.path);
    if (!isTest && !isRetryConfig) continue;
    for (const [i, a] of d.added.entries()) {
      const hit = (kind: Hit['kind'], advice: string): void => {
        hits.push({ file: d.path, line: a.line, kind, text: a.text.trim(), advice });
      };
      if (isTest && SKIP.test(a.text) && !isPlatformGuard(d.added, i)) hit('skip', 'Remove the skip, xfail or .only. Fix the test or the code instead.');
      if (isTest && SLEEP.test(a.text)) hit('sleep', 'Do not wait a fixed time. Wait for the real condition (poll the state, await the event).');
      if (RETRY_MARK.test(a.text)) hit('retry', 'Do not add retries or reruns. Find out why the test is flaky and fix that.');
      else if (RETRIES_SETTING.test(a.text)) {
        const before = Math.max(0, ...d.removed.filter((r) => RETRIES_SETTING.test(r.text)).map((r) => maxNumber(r.text)));
        if (maxNumber(a.text) > before) hit('retry', 'Do not raise the retry count. Find out why the test is flaky and fix that.');
      }
    }
    if (!isTest) continue;
    for (const r of d.removed) {
      const name = testName(r.text);
      if (!name || addedNames.has(name) || inLog(logText, name)) continue;
      hits.push({
        file: d.path,
        line: r.line,
        kind: 'removed-test',
        text: r.text.trim(),
        advice: `Test "${name}" was removed. Restore it, or add a line to ${removalsLog} with its name and why it was removed.`,
      });
    }
  }
  return hits;
}

export function formatHits(hits: Hit[]): string {
  return hits.map((h) => `${h.file}:${h.line}${h.kind === 'removed-test' ? ' (old line)' : ''} [${h.kind}] ${h.text}\n  -> ${h.advice}`).join('\n');
}
