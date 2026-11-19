// Small glob matcher for repo-relative paths with "/" separators.
// "**" = any number of path segments (also zero), "*" = any chars except "/", "?" = one char except "/".
// Patterns are anchored at the repo root.

const cache = new Map<string, RegExp>();

export const PLACEHOLDER = '{name}';

export function globToRegExp(pattern: string): RegExp {
  return compile(pattern, false);
}

/**
 * Like globToRegExp, but "{name}" becomes a capture group for one whole path segment.
 * A second "{name}" in the same pattern must match the same text.
 */
export function templateToRegExp(pattern: string): RegExp {
  return compile(pattern, true);
}

/**
 * Expands brace alternation: "**\/*.{spec,test}.ts" becomes two patterns. Only a group with a comma counts;
 * a bare "{word}" (such as {name}) is left alone. Nested groups are expanded too.
 */
export function expandBraces(pattern: string): string[] {
  for (let open = pattern.indexOf('{'); open !== -1; open = pattern.indexOf('{', open + 1)) {
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        close = i;
        break;
      } else if (c === ',' && depth === 1) commas.push(i);
    }
    if (close === -1 || commas.length === 0) continue;
    const bounds = [open, ...commas, close];
    const head = pattern.slice(0, open);
    const tail = pattern.slice(close + 1);
    const out: string[] = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      for (const alt of expandBraces(pattern.slice((bounds[k] as number) + 1, bounds[k + 1]))) {
        for (const rest of expandBraces(tail)) out.push(head + alt + rest);
      }
    }
    return out;
  }
  return [pattern];
}

function compile(pattern: string, template: boolean): RegExp {
  const key = `${template ? 't' : 'g'}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!template) {
    const alts = expandBraces(pattern);
    if (alts.length > 1) {
      const out = new RegExp(alts.map((a) => `(?:${compile(a, false).source})`).join('|'));
      cache.set(key, out);
      return out;
    }
  }
  let re = '';
  let i = 0;
  let holes = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (template && pattern.startsWith(PLACEHOLDER, i)) {
      re += holes === 0 ? '([^/]+)' : '\\1';
      holes += 1;
      i += PLACEHOLDER.length;
      continue;
    }
    if (c === '*' && pattern[i + 1] === '*') {
      const atStart = i === 0 || pattern[i - 1] === '/';
      const next = pattern[i + 2];
      if (atStart && next === '/') {
        re += '(?:.*/)?'; // "**/" matches zero or more leading folders
        i += 3;
        continue;
      }
      if (atStart && next === undefined) {
        // "dir/**" matches everything under dir; a lone "**" matches everything.
        // In a template, "{name}/**" must have a file under the folder: "src/app.py" is not module "app.py".
        if (template && re.endsWith('/')) re += '.+';
        else if (re.endsWith('/')) re = re.slice(0, -1) + '(?:/.*)?';
        else re += '.*';
        i += 2;
        continue;
      }
      re += '.*';
      i += 2;
      continue;
    }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  const out = new RegExp(`^${re}$`);
  cache.set(key, out);
  return out;
}

export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path.replace(/\\/g, '/'));
}

export function matchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}
