/**
 * What the reviewer is shown around the diff.
 *
 * GitHub's patch carries three lines of context, which is enough to see that a
 * line changed and not enough to say whether the change is wrong. The two
 * failure directions both come from that: a bug that needs the rest of the
 * function goes unreported, and a finding about code the model cannot see gets
 * reported confidently anyway.
 *
 * So a changed file is shown whole where it fits, with the diff marked inside
 * it, and the files it imports and is tested by are shown alongside it. The
 * budget is in lines rather than tokens because the thing being protected is a
 * context window, and a line is what a reader and a tokenizer roughly agree on.
 *
 * Everything here except `gather` is pure, which is what makes the rendering
 * and the resolution testable without a repository.
 */
import type { DiffFile } from './diff.ts';
import type { GitHub } from './github.ts';
import { log } from './log.ts';

/**
 * How a line is marked in a rendered file.
 *
 * The distinction that matters is commentable versus not. `+` and `=` are in
 * the diff and can carry a comment; an unmarked line is context the model may
 * read and must not anchor to, because GitHub rejects the whole review over one
 * comment on a line outside the diff.
 */
export interface RenderOptions {
  /** Most lines of a changed file to show before falling back to windows. */
  readonly maxFileLines: number;
  /** Lines shown either side of a hunk when the whole file does not fit. */
  readonly window: number;
}

export const DEFAULT_RENDER: RenderOptions = {
  maxFileLines: 600,
  window: 45,
};

/** Right-hand line numbers that are in the diff, and how each one changed. */
const diffMarks = (file: DiffFile): ReadonlyMap<number, '+' | '='> => {
  const marks = new Map<number, '+' | '='>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.right === undefined) continue;
      marks.set(line.right, line.kind === 'add' ? '+' : '=');
    }
  }
  return marks;
};

/** Deleted lines, keyed by the right-hand line they sat before. */
const deletions = (file: DiffFile): ReadonlyMap<number, readonly string[]> => {
  const map = new Map<number, string[]>();
  for (const hunk of file.hunks) {
    // The next right-hand line after a run of deletions is where they belong.
    let pending: string[] = [];
    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        pending.push(line.text);
        continue;
      }
      if (pending.length > 0 && line.right !== undefined) {
        map.set(line.right, [...(map.get(line.right) ?? []), ...pending]);
        pending = [];
      }
    }
  }
  return map;
};

/**
 * The line ranges worth showing when a file is too large to show whole: each
 * hunk with `window` lines either side, overlapping ranges merged.
 */
export const windowsFor = (
  file: DiffFile,
  total: number,
  window: number,
): readonly (readonly [number, number])[] => {
  const ranges: [number, number][] = [];

  for (const hunk of file.hunks) {
    const rights = hunk.lines
      .map((line) => line.right)
      .filter((line): line is number => line !== undefined);
    if (rights.length === 0) continue;

    const from = Math.max(1, Math.min(...rights) - window);
    const to = Math.min(total, Math.max(...rights) + window);
    const last = ranges.at(-1);

    // Merged when they touch as well as when they overlap, so two hunks a line
    // apart do not produce a gap marker with nothing in it.
    if (last !== undefined && from <= last[1] + 1)
      last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  return ranges;
};

/**
 * A changed file rendered with its real contents and the diff marked inside it.
 *
 * Falls back to the patch alone when there are no contents, which is a deleted,
 * binary or oversized file.
 */
export const renderWithContext = (
  file: DiffFile,
  content: string | undefined,
  options: RenderOptions = DEFAULT_RENDER,
): string => {
  const head = `### ${file.path} (${file.status})`;

  if (content === undefined) {
    return [
      head,
      '_Contents unavailable: deleted, binary, or too large. Diff only._',
      '```diff',
      ...file.hunks.map((hunk) =>
        [
          hunk.header,
          ...hunk.lines.map(
            (line) =>
              `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}`,
          ),
        ].join('\n'),
      ),
      '```',
    ].join('\n');
  }

  const lines = content.split('\n');
  const marks = diffMarks(file);
  const removed = deletions(file);
  const whole = lines.length <= options.maxFileLines;
  const ranges = whole
    ? [[1, lines.length] as const]
    : windowsFor(file, lines.length, options.window);

  const out: string[] = [];
  let previousEnd = 0;

  for (const [from, to] of ranges) {
    if (from > previousEnd + 1)
      out.push(`       ... ${from - previousEnd - 1} line(s) not shown ...`);
    for (let number = from; number <= to; number++) {
      for (const gone of removed.get(number) ?? []) {
        out.push(`     - | ${gone}`);
      }
      out.push(
        `${String(number).padStart(5)} ${marks.get(number) ?? ' '} | ${lines[number - 1] ?? ''}`,
      );
    }
    previousEnd = to;
  }
  if (previousEnd < lines.length) {
    out.push(`       ... ${lines.length - previousEnd} line(s) not shown ...`);
  }

  return [
    head,
    whole
      ? '_Whole file at this commit._'
      : '_The changed regions of the file at this commit._',
    '```',
    ...out,
    '```',
  ].join('\n');
};

/** A read-only file shown purely as background. */
export const renderReference = (
  path: string,
  content: string,
  maxLines: number,
): string => {
  const lines = content.split('\n');
  const shown = lines.slice(0, maxLines);
  return [
    `### ${path} (not changed, for reference)`,
    '```',
    ...shown.map(
      (line, index) => `${String(index + 1).padStart(5)}   | ${line}`,
    ),
    ...(lines.length > shown.length
      ? [`       ... ${lines.length - shown.length} line(s) not shown ...`]
      : []),
    '```',
  ].join('\n');
};

const RELATIVE = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** Relative import specifiers, which are the only ones that name this repository. */
export const importSpecs = (content: string): readonly string[] => [
  ...new Set([...content.matchAll(RELATIVE)].map((match) => match[1] ?? '')),
];

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');

/** `a/b/../c` to `a/c`, without touching the filesystem. */
const normalize = (path: string): string => {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
};

/**
 * A specifier to a path in the repository.
 *
 * `./foo.js` resolving to `foo.ts` is the case that matters: under `nodenext` a
 * TypeScript project writes the extension it will emit, not the one on disk, so
 * matching the literal specifier finds nothing in a repository that compiles.
 */
export const resolveImport = (
  from: string,
  spec: string,
  tree: ReadonlySet<string>,
): string | undefined => {
  const base = normalize(`${dirOf(from)}/${spec}`);
  const withoutExt = base.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, '');
  const candidates = [
    base,
    ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs'].flatMap((ext) => [
      `${withoutExt}.${ext}`,
      `${withoutExt}/index.${ext}`,
    ]),
  ];
  return candidates.find((candidate) => tree.has(candidate));
};

/** The test file for a source file, by the conventions people actually use. */
export const testPathFor = (
  path: string,
  tree: ReadonlySet<string>,
): string | undefined => {
  const match = /^(.*)\.(ts|tsx|mts|cts|js|jsx|mjs)$/.exec(path);
  if (match === null) return undefined;
  const [, stem = '', ext = ''] = match;
  const base = stem.split('/').pop() ?? '';
  const dir = dirOf(stem);

  return [
    `${stem}.test.${ext}`,
    `${stem}.spec.${ext}`,
    `${dir}/__tests__/${base}.${ext}`,
    `${dir}/__tests__/${base}.test.${ext}`,
    `test/${base}.test.${ext}`,
    `tests/${base}.test.${ext}`,
  ].find((candidate) => tree.has(candidate));
};

/**
 * Files worth showing alongside a changed one: what it imports from this
 * repository, and what tests it.
 *
 * Tests first. A test states the contract the change has to keep, which is the
 * single most useful thing to have next to a diff, and it is also the file most
 * likely to be missing from the diff when it should not be.
 */
export const relatedFor = (
  path: string,
  content: string,
  tree: ReadonlySet<string>,
  limit: number,
): readonly string[] => {
  const found: string[] = [];
  const test = testPathFor(path, tree);
  if (test !== undefined) found.push(test);

  for (const spec of importSpecs(content)) {
    if (found.length >= limit) break;
    const resolved = resolveImport(path, spec, tree);
    if (resolved !== undefined && !found.includes(resolved))
      found.push(resolved);
  }

  return found.slice(0, limit);
};

export interface GatheredFile {
  readonly file: DiffFile;
  readonly content: string | undefined;
}

export interface Gathered {
  readonly changed: readonly GatheredFile[];
  /** Path to contents, for files shown only as background. */
  readonly references: ReadonlyMap<string, string>;
}

export interface GatherOptions {
  readonly related: boolean;
  readonly relatedPerFile: number;
  readonly maxReferences: number;
}

/**
 * Fetches the contents behind a review.
 *
 * Changed files first and always: they are the review. References are filled in
 * afterwards up to a cap, so a pull request touching forty files does not pull
 * in eighty more and spend the whole context window on background.
 */
export const gather = async (
  github: GitHub,
  owner: string,
  repo: string,
  ref: string,
  files: readonly DiffFile[],
  options: GatherOptions,
): Promise<Gathered> => {
  const changed: GatheredFile[] = [];
  for (const file of files) {
    changed.push({
      file,
      content:
        file.status === 'removed'
          ? undefined
          : await github.fileContent(owner, repo, file.path, ref),
    });
  }

  const references = new Map<string, string>();
  if (!options.related) return { changed, references };

  const tree = await github.tree(owner, repo, ref);
  if (tree.size === 0) return { changed, references };

  const changedPaths = new Set(files.map((file) => file.path));
  const wanted: string[] = [];

  for (const { file, content } of changed) {
    if (content === undefined) continue;
    for (const path of relatedFor(
      file.path,
      content,
      tree,
      options.relatedPerFile,
    )) {
      // A related file that is itself in the diff is already shown in full.
      if (!changedPaths.has(path) && !wanted.includes(path)) wanted.push(path);
    }
  }

  for (const path of wanted.slice(0, options.maxReferences)) {
    const content = await github.fileContent(owner, repo, path, ref);
    if (content !== undefined) references.set(path, content);
  }

  log.info(
    `Context: ${changed.filter((entry) => entry.content !== undefined).length}` +
      `/${changed.length} changed file(s) read in full, ` +
      `${references.size} related file(s) alongside.`,
  );

  return { changed, references };
};
