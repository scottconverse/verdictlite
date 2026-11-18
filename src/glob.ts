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

function compile(pattern: string, template: boolean): RegExp {
  const key = `${template ? 't' : 'g'}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
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
