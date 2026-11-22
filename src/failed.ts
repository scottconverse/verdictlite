import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FILES_TOKEN as FILES } from './config.js';
import { quoteArg } from './proc.js';

/** The most failed tests VerdictLite will save for one check. More than this runs the full check next time. */
export const MAX_FAILED_IDS = 50;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * The failed tests named in a test runner's output, in order, without repeats. Knows pytest (`FAILED <nodeid>`,
 * `ERROR <path>`, any ` - message` suffix removed) and vitest or jest (` FAIL  <file> > name`, the file is kept).
 * Output in any other format gives an empty list.
 */
export function parseFailedIds(output: string): string[] {
  const ids: string[] = [];
  for (const raw of stripAnsi(output).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let id: string | undefined;
    const py = /^(?:FAILED|ERROR) (\S.*)$/.exec(line);
    if (py) {
      id = (py[1] as string).split(' - ')[0]?.trim();
    } else {
      const js = /^\s*FAIL\s+(\S.*)$/.exec(line);
      if (js) {
        id = (js[1] as string).split(' > ')[0]?.replace(/\s+\(\d+(?:\.\d+)?\s*m?s\)$/, '').trim();
      }
    }
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** True when every id is safe to pass to a command: not an option, no line break, and its file exists under base. At most MAX_FAILED_IDS, at least one. */
export function idsAreSafe(ids: string[], base: string): boolean {
  if (ids.length === 0 || ids.length > MAX_FAILED_IDS) return false;
  return ids.every((id) => {
    if (id === '' || id.startsWith('-') || /[\r\n\0]/.test(id)) return false;
    const file = id.split('::')[0] as string;
    return file !== '' && existsSync(resolve(base, file));
  });
}

/** The failed tests of one run when all of them are safe to save, or null (record nothing, run in full next time). */
export function failedIdsOf(output: string, base: string): string[] | null {
  const ids = parseFailedIds(output);
  return idsAreSafe(ids, base) ? ids : null;
}

/** The check's runFiles with {files} replaced by the quoted ids. */
export function idsCommand(runFiles: string, ids: string[]): string {
  return runFiles.split(FILES).join(ids.map(quoteArg).join(' '));
}
