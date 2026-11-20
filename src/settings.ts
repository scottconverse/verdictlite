import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';
import { vliteHome } from './state.js';

export interface Settings {
  /** GitHub orgs (lowercase) whose repos must all have a vlite.json. */
  requiredOrgs: string[];
}

export function settingsPath(): string {
  return join(vliteHome(), 'settings.json');
}

/** Reads settings.json. A missing file gives the defaults. A bad file warns on stderr and gives the defaults. Never throws. */
export function readSettings(): Settings {
  const defaults: Settings = { requiredOrgs: [] };
  const file = settingsPath();
  try {
    if (!existsSync(file)) return defaults;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('top level must be an object');
    const orgs = (raw as { requiredOrgs?: unknown }).requiredOrgs;
    if (orgs === undefined) return defaults;
    if (!Array.isArray(orgs)) throw new Error('requiredOrgs must be a list');
    return { requiredOrgs: orgs.filter((o): o is string => typeof o === 'string').map((o) => o.trim().toLowerCase()).filter(Boolean) };
  } catch (e) {
    process.stderr.write(`VerdictLite: could not read ${file} (using defaults): ${(e as Error).message}\n`);
    return defaults;
  }
}

/** Writes settings.json atomically: a temp file, then a rename. */
export function writeSettings(s: Settings): void {
  const file = settingsPath();
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The GitHub owner of a remote URL, lowercase. Null for another host or an odd URL. */
export function githubOwner(url: string): string | null {
  const u = url.trim();
  const m =
    /^https?:\/\/(?:[^/@\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/[^/\s]+/i.exec(u) ??
    /^(?:ssh:\/\/)?(?:[^/@\s]+@)?github\.com[:/]([^/\s]+)\/[^/\s]+/i.exec(u);
  const owner = m?.[1];
  return owner ? owner.toLowerCase() : null;
}

/** The GitHub owner of the origin remote of a repo, or null (no origin, other host). */
export function originOwner(root: string): string | null {
  try {
    const r = git(root, ['remote', 'get-url', 'origin']);
    return r.ok ? githubOwner(r.out) : null;
  } catch {
    return null;
  }
}
