import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refExists, showFile } from './git.js';
import { PLACEHOLDER } from './glob.js';

export interface Check {
  name: string;
  run: string;
  /** Optional narrow form: like run, with {files} for the changed test files. Used only when just tests changed since the part last passed. */
  runFiles?: string;
  cwd: string;
  timeoutSec: number;
}

export interface Part {
  name: string;
  paths: string[];
  /** Repo-relative paths that must exist in the working tree, or the part is skipped. */
  requires: string[];
  cwd: string;
  checks: Check[];
  /** True when a path holds {name}: one concrete part is made per module that changed. */
  template: boolean;
}

export type GateMode = 'off' | 'observe' | 'enforce';

export interface Config {
  version: 1;
  base: string;
  docs: string[];
  codeDespiteDocs: string[];
  parts: Part[];
  /** Most concrete parts one template may make in one run. */
  maxExpandedParts: number;
  tests: { paths: string[]; /** Globs of real test files. Narrow mode runs only when every changed file under paths matches one. */ files: string[]; removalsLog: string };
  maxRounds: number;
  gate: { mode: GateMode };
  review: { command: string; args: string[]; rulesFile: string; timeoutSec: number };
}

export interface LoadedConfig {
  config: Config;
  source: 'base' | 'worktree';
  ref: string | null;
}

/** Where the changed test files go in a check's runFiles. */
export const FILES_TOKEN = '{files}';

export class ConfigError extends Error {}

const FILE = 'vlite.json';
/** Default globs for real test files (not helpers, fixtures or conftest.py). */
export const DEFAULT_TEST_FILES = ['**/test_*.py', '**/*_test.py', '**/*.test.*', '**/*.spec.*', '**/*_test.go'];

const DEFAULT_REFS = ['origin/main', 'main'];

/**
 * Reads vlite.json from the base ref so the change under judgement cannot edit its own checks.
 * Falls back to the working tree only when no base ref has the file (bootstrap). Returns null when there is no config at all.
 */
export function loadConfig(root: string): LoadedConfig | null {
  for (const ref of DEFAULT_REFS) {
    if (!refExists(root, ref)) continue;
    const text = showFile(root, ref, FILE);
    if (text === null) continue;
    const config = parseConfig(text, `${ref}:${FILE}`);
    // The config may name another base; prefer its copy when that ref has one.
    if (config.base !== ref && refExists(root, config.base)) {
      const other = showFile(root, config.base, FILE);
      if (other !== null) return { config: parseConfig(other, `${config.base}:${FILE}`), source: 'base', ref: config.base };
    }
    return { config, source: 'base', ref };
  }
  const path = join(root, FILE);
  if (!existsSync(path)) return null;
  return { config: parseConfig(readFileSync(path, 'utf8'), path), source: 'worktree', ref: null };
}

export function parseConfig(text: string, where: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new ConfigError(`${where}: not valid JSON (${(e as Error).message})`);
  }
  const errors: string[] = [];
  const cfg = validate(raw, errors);
  if (errors.length > 0 || !cfg) throw new ConfigError(`${where} has errors:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

/** Top-level keys of vlite.json. "prChecks" is an old field that is ignored. */
const TOP_KEYS = new Set(['version', 'base', 'docs', 'codeDespiteDocs', 'parts', 'maxExpandedParts', 'tests', 'maxRounds', 'gate', 'review', 'prChecks']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function strings(v: unknown, at: string, errors: string[], fallback: string[]): string[] {
  if (v === undefined) return fallback;
  if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return v as string[];
  errors.push(`${at} must be a list of strings`);
  return fallback;
}

function str(v: unknown, at: string, errors: string[], fallback?: string): string {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v === 'string' && v.trim() !== '') return v;
  errors.push(`${at} must be a non-empty string`);
  return fallback ?? '';
}

function posNum(v: unknown, at: string, errors: string[], fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  errors.push(`${at} must be a number above 0`);
  return fallback;
}

let warnedPrChecks = false;

/** A placeholder token such as {name} or {module}. A group with a comma, like {ts,tsx}, is alternation, not a token. */
const TOKEN = /\{[^{},/]*\}/g;

/** Checks the {name} rules of one part. Returns true when the part is a template. */
function placeholderRules(p: { name: string; paths: string[]; requires: string[]; cwd: string; checks: Check[] }, at: string, errors: string[]): boolean {
  let template = false;
  p.paths.forEach((path, i) => {
    for (const token of path.match(TOKEN) ?? []) {
      if (token !== PLACEHOLDER) errors.push(`${at}.paths[${i}] uses "${token}"; the only placeholder is {name}`);
    }
    if (!path.includes(PLACEHOLDER)) return;
    template = true;
    if (path.split('/').some((seg) => seg.includes(PLACEHOLDER) && seg !== PLACEHOLDER)) {
      errors.push(`${at}.paths[${i}]: {name} must be a whole path segment, like "src/{name}/**"`);
    }
  });
  const uses: string[] = [];
  if (p.name.includes(PLACEHOLDER)) uses.push('"name"');
  if (p.cwd.includes(PLACEHOLDER)) uses.push('"cwd"');
  if (p.requires.some((r) => r.includes(PLACEHOLDER))) uses.push('"requires"');
  p.checks.forEach((c, i) => {
    if (c.run.includes(PLACEHOLDER)) uses.push(`checks[${i}].run`);
    if (c.runFiles?.includes(PLACEHOLDER)) uses.push(`checks[${i}].runFiles`);
    if (c.cwd.includes(PLACEHOLDER) && c.cwd !== p.cwd) uses.push(`checks[${i}].cwd`);
  });
  if (!template) {
    if (uses.length > 0) errors.push(`${at} uses {name} in ${uses.join(', ')}, but none of its paths has {name}`);
    return false;
  }
  if (!p.name.includes(PLACEHOLDER)) errors.push(`${at}.name must contain {name}, so each module gets its own part name (like "backend:{name}")`);
  p.paths.forEach((path, i) => {
    if (!path.includes(PLACEHOLDER)) errors.push(`${at}.paths[${i}] has no {name}; in a template part every path needs {name}`);
  });
  return true;
}

function checks(v: unknown, at: string, errors: string[], cwd: string): Check[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push(`${at} must be a list`);
    return [];
  }
  return v.map((c: unknown, i) => {
    const here = `${at}[${i}]`;
    if (!isObj(c)) {
      errors.push(`${here} must be an object`);
      return { name: '', run: '', cwd, timeoutSec: 600 };
    }
    let runFiles: string | undefined;
    if (c['runFiles'] !== undefined) {
      runFiles = str(c['runFiles'], `${here}.runFiles`, errors);
      if (runFiles !== '' && !runFiles.includes(FILES_TOKEN)) errors.push(`${here}.runFiles must contain ${FILES_TOKEN}, where the changed test files go (for example "pytest ${FILES_TOKEN} -q")`);
    }
    return {
      name: str(c['name'], `${here}.name`, errors),
      run: str(c['run'], `${here}.run`, errors),
      ...(runFiles ? { runFiles } : {}),
      cwd: str(c['cwd'], `${here}.cwd`, errors, cwd),
      timeoutSec: posNum(c['timeoutSec'], `${here}.timeoutSec`, errors, 600),
    };
  });
}

function validate(raw: unknown, errors: string[]): Config | null {
  if (!isObj(raw)) {
    errors.push('the top level must be a JSON object');
    return null;
  }
  if (raw['version'] !== 1) errors.push('"version" must be 1');
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) errors.push(`unknown top-level key "${key}" (a typo? allowed: ${[...TOP_KEYS].join(', ')})`);
  }
  const partsRaw = raw['parts'] ?? [];
  const parts: Part[] = [];
  if (!Array.isArray(partsRaw)) errors.push('"parts" must be a list');
  else
    partsRaw.forEach((p: unknown, i) => {
      const at = `parts[${i}]`;
      if (!isObj(p)) {
        errors.push(`${at} must be an object`);
        return;
      }
      const cwd = str(p['cwd'], `${at}.cwd`, errors, '.');
      const paths = strings(p['paths'], `${at}.paths`, errors, []);
      if (paths.length === 0) errors.push(`${at}.paths must list at least one glob`);
      const requires = strings(p['requires'], `${at}.requires`, errors, []);
      const list = checks(p['checks'], `${at}.checks`, errors, cwd);
      if (list.length === 0) errors.push(`${at}.checks must list at least one check`);
      const part = { name: str(p['name'], `${at}.name`, errors), paths, requires, cwd, checks: list };
      parts.push({ ...part, template: placeholderRules(part, at, errors) });
    });
  const tests = isObj(raw['tests']) ? raw['tests'] : {};
  if (raw['tests'] !== undefined && !isObj(raw['tests'])) errors.push('"tests" must be an object');
  const gate = isObj(raw['gate']) ? raw['gate'] : {};
  const mode = gate['mode'] ?? 'observe';
  if (mode !== 'off' && mode !== 'observe' && mode !== 'enforce') errors.push('"gate.mode" must be "off", "observe" or "enforce"');
  const review = isObj(raw['review']) ? raw['review'] : {};
  const maxRounds = raw['maxRounds'] ?? 3;
  const maxExpanded = raw['maxExpandedParts'] ?? 12;
  if (typeof maxExpanded !== 'number' || !Number.isInteger(maxExpanded) || maxExpanded < 1) errors.push('"maxExpandedParts" must be a whole number of 1 or more');
  if (raw['prChecks'] !== undefined && !warnedPrChecks) {
    warnedPrChecks = true;
    process.stderr.write('VerdictLite: "prChecks" in vlite.json is no longer used and is ignored; you can remove it.\n');
  }
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) errors.push('"maxRounds" must be a whole number of 1 or more');
  return {
    version: 1,
    base: str(raw['base'], '"base"', errors, 'origin/main'),
    docs: strings(raw['docs'], '"docs"', errors, []),
    codeDespiteDocs: strings(raw['codeDespiteDocs'], '"codeDespiteDocs"', errors, []),
    parts,
    maxExpandedParts: typeof maxExpanded === 'number' ? maxExpanded : 12,
    tests: {
      paths: strings(tests['paths'], '"tests.paths"', errors, []),
      files: strings(tests['files'], '"tests.files"', errors, DEFAULT_TEST_FILES),
      removalsLog: str(tests['removalsLog'], '"tests.removalsLog"', errors, 'TEST-REMOVALS.md'),
    },
    maxRounds: typeof maxRounds === 'number' ? maxRounds : 3,
    gate: { mode: mode as GateMode },
    review: {
      command: str(review['command'], '"review.command"', errors, 'claude'),
      args: strings(review['args'], '"review.args"', errors, ['-p']),
      rulesFile: str(review['rulesFile'], '"review.rulesFile"', errors, 'REVIEW.md'),
      timeoutSec: posNum(review['timeoutSec'], '"review.timeoutSec"', errors, 900),
    },
  };
}
