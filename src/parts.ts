import type { Part } from './config.js';
import { matchAny, PLACEHOLDER, templateToRegExp } from './glob.js';

/** A bound {name} value goes into a shell command, so only plain names are allowed. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A template that matched more modules than maxExpandedParts; none of its parts run. */
export interface TooMany {
  template: string;
  names: string[];
}

export interface PartPlan {
  /** Concrete parts to run, in config order; a template's parts are sorted by module name. */
  parts: Part[];
  tooMany: TooMany[];
}

/** The {name} values a template part binds from the changed files (deduped, sorted). Unsafe values never bind. */
export function bindNames(part: Part, changed: readonly string[]): string[] {
  const names = new Set<string>();
  for (const pattern of part.paths) {
    if (!pattern.includes(PLACEHOLDER)) continue;
    const re = templateToRegExp(pattern);
    for (const file of changed) {
      const value = re.exec(file.replace(/\\/g, '/'))?.[1];
      if (value !== undefined && SAFE_NAME.test(value)) names.add(value);
    }
  }
  return [...names].sort();
}

/** The part with every {name} replaced by value. */
export function expandPart(part: Part, value: string): Part {
  const fill = (s: string): string => s.split(PLACEHOLDER).join(value);
  return {
    name: fill(part.name),
    paths: part.paths.map(fill),
    requires: part.requires.map(fill),
    cwd: fill(part.cwd),
    checks: part.checks.map((c) => ({ ...c, run: fill(c.run), cwd: fill(c.cwd) })),
    template: false,
  };
}

/** Picks the parts the changed files touch, and expands templates into one part per module. */
export function planParts(parts: readonly Part[], changed: readonly string[], maxExpanded: number): PartPlan {
  const plan: PartPlan = { parts: [], tooMany: [] };
  for (const part of parts) {
    if (!part.template) {
      if (changed.some((f) => matchAny(part.paths, f))) plan.parts.push(part);
      continue;
    }
    const names = bindNames(part, changed);
    if (names.length > maxExpanded) {
      plan.tooMany.push({ template: part.name, names: names.map((n) => expandPart(part, n).name) });
      continue;
    }
    for (const n of names) plan.parts.push(expandPart(part, n));
  }
  return plan;
}
