/**
 * Which files the review is shown.
 *
 * Glob matching, written out rather than taken as a dependency: the patterns an
 * exclude list actually contains are `*.md`, `dist/**` and `**` + `/*.snap`, and
 * the corners a full glob library exists for - brace expansion, extglobs,
 * negation classes - are corners nobody puts in a comma-separated action input.
 */

/** Characters that mean something to a regular expression but not to a glob. */
const LITERAL = /[.+^${}()|[\]\\]/;

/**
 * A glob to a regular expression, scanned once left to right.
 *
 * A single pass rather than chained `replace` calls, because the patterns
 * overlap: `*` is a prefix of `**`, and `**` followed by a slash means something
 * different from `**` on its own. Replacing in sequence means each pass has to
 * avoid the output of the last one, which is where placeholder sentinels come
 * from and where they go wrong.
 *
 * A leading `**` plus slash also matches zero directories, so `**` + `/*.snap`
 * matches a snapshot at the repository root and not only one inside a folder.
 */
const toRegExp = (pattern: string): RegExp => {
  let source = '';

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';

    if (char === '*') {
      const deep = pattern[index + 1] === '*';
      if (deep && pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else if (deep) {
        source += '.*';
        index += 1;
      } else {
        // A single star stops at a separator: `dist/*` is one level, not a tree.
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += LITERAL.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${source}$`);
};

/**
 * A pattern with no slash in it is matched against the basename as well as the
 * whole path, so `*.md` means "any markdown file" rather than "markdown at the
 * root" - which is what someone writing it into a workflow means by it.
 */
export const matches = (path: string, pattern: string): boolean => {
  const regex = toRegExp(pattern);
  if (regex.test(path)) return true;
  if (pattern.includes('/')) return false;
  return regex.test(path.split('/').pop() ?? path);
};

export const excluded = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => matches(path, pattern));
