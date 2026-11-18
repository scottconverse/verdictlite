import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refExists, showFile } from './git.js';

export interface Check {
  name: string;
  run: string;
  cwd: string;
  timeoutSec: number;
}

export interface Part {
  name: string;
  paths: string[];
  cwd: string;
  checks: Check[];
}

export type GateMode = 'off' | 'observe' | 'enforce';

export interface Config {
  version: 1;
  base: string;
  docs: string[];
  codeDespiteDocs: string[];
  parts: Part[];
  prChecks: Check[];
  tests: { paths: string[]; removalsLog: string };
  maxRounds: number;
  gate: { mode: GateMode };
  review: { command: string; args: string[]; rulesFile: string; timeoutSec: number };
}

export interface LoadedConfig {
  config: Config;
  source: 'base' | 'worktree';
  ref: string | null;
}

export class ConfigError extends Error {}

const FILE = 'vlite.json';
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
    return {
      name: str(c['name'], `${here}.name`, errors),
      run: str(c['run'], `${here}.run`, errors),
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
      const list = checks(p['checks'], `${at}.checks`, errors, cwd);
      if (list.length === 0) errors.push(`${at}.checks must list at least one check`);
      parts.push({ name: str(p['name'], `${at}.name`, errors), paths, cwd, checks: list });
    });
  const tests = isObj(raw['tests']) ? raw['tests'] : {};
  if (raw['tests'] !== undefined && !isObj(raw['tests'])) errors.push('"tests" must be an object');
  const gate = isObj(raw['gate']) ? raw['gate'] : {};
  const mode = gate['mode'] ?? 'observe';
  if (mode !== 'off' && mode !== 'observe' && mode !== 'enforce') errors.push('"gate.mode" must be "off", "observe" or "enforce"');
  const review = isObj(raw['review']) ? raw['review'] : {};
  const maxRounds = raw['maxRounds'] ?? 3;
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) errors.push('"maxRounds" must be a whole number of 1 or more');
  return {
    version: 1,
    base: str(raw['base'], '"base"', errors, 'origin/main'),
    docs: strings(raw['docs'], '"docs"', errors, []),
    codeDespiteDocs: strings(raw['codeDespiteDocs'], '"codeDespiteDocs"', errors, []),
    parts,
    prChecks: checks(raw['prChecks'], '"prChecks"', errors, '.'),
    tests: {
      paths: strings(tests['paths'], '"tests.paths"', errors, []),
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
