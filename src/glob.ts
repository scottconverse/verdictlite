// Small glob matcher for repo-relative paths with "/" separators.
// "**" = any number of path segments (also zero), "*" = any chars except "/", "?" = one char except "/".
// Patterns are anchored at the repo root.

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '*' && pattern[i + 1] === '*') {
      const atStart = i === 0 || pattern[i - 1] === '/';
      const next = pattern[i + 2];
      if (atStart && next === '/') {
        re += '(?:.*/)?'; // "**/" matches zero or more leading folders
        i += 3;
        continue;
      }
      if (atStart && next === undefined) {
        // "dir/**" matches everything under dir; a lone "**" matches everything
        if (re.endsWith('/')) re = re.slice(0, -1) + '(?:/.*)?';
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
  cache.set(pattern, out);
  return out;
}

export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path.replace(/\\/g, '/'));
}

export function matchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}
