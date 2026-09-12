/**
 * The diff, as GitHub already sliced it.
 *
 * `GET /pulls/{n}/files` returns one `patch` per file, so there is no
 * `diff --git` stream to parse and no filename quoting or rename detection to get
 * wrong - the filename arrives in its own field. What is left is reading `@@`
 * headers to recover the right-hand line numbers, which is the one thing the
 * rest of this action cannot do without: a comment may only be posted on a line
 * that is in the diff, and GitHub rejects the **whole** review if any single
 * comment names a line that is not.
 */

export interface DiffLine {
  readonly kind: 'add' | 'del' | 'ctx';
  /** Line number on the right-hand side, absent for a deletion. */
  readonly right: number | undefined;
  readonly text: string;
}

export interface Hunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly path: string;
  readonly status: string;
  readonly hunks: readonly Hunk[];
}

/** Right-hand line numbers per file: exactly the lines GitHub will accept. */
export type Commentable = ReadonlyMap<string, ReadonlySet<number>>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A file's patch into hunks.
 *
 * A patch is absent for a binary file and for one too large for GitHub to
 * inline, and both come back as no hunks rather than an error: there is nothing
 * to review in either, and the file should not sink the run.
 */
export const parsePatch = (patch: string | undefined): readonly Hunk[] => {
  if (patch === undefined || patch === '') return [];

  const hunks: Hunk[] = [];
  let lines: DiffLine[] = [];
  let header = '';
  let cursor = 0;

  const flush = (): void => {
    if (header !== '') hunks.push({ header, lines });
  };

  for (const row of patch.split('\n')) {
    const start = HUNK.exec(row);
    if (start) {
      flush();
      header = row;
      lines = [];
      cursor = Number(start[1]);
      continue;
    }
    if (header === '') continue;

    // `\ No newline at end of file` is diff metadata rather than a line of the
    // file, and counting it would shift every line number after it by one.
    if (row.startsWith('\\')) continue;

    if (row.startsWith('-')) {
      lines.push({ kind: 'del', right: undefined, text: row.slice(1) });
      continue;
    }
    if (row.startsWith('+')) {
      lines.push({ kind: 'add', right: cursor, text: row.slice(1) });
      cursor += 1;
      continue;
    }
    // A context line, including the empty string an unchanged blank line becomes
    // once the leading space is stripped by whatever produced the patch.
    lines.push({ kind: 'ctx', right: cursor, text: row.replace(/^ /, '') });
    cursor += 1;
  }

  flush();
  return hunks;
};

export const parseFiles = (
  files: readonly {
    readonly filename: string;
    readonly status?: string;
    readonly patch?: string;
  }[],
): readonly DiffFile[] =>
  files.map((file) => ({
    path: file.filename,
    status: file.status ?? 'modified',
    hunks: parsePatch(file.patch),
  }));

export const commentableLines = (files: readonly DiffFile[]): Commentable => {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.right !== undefined) lines.add(line.right);
      }
    }
    map.set(file.path, lines);
  }
  return map;
};

/**
 * A hunk rendered with the line numbers the model is expected to cite back.
 *
 * Models are poor at counting rows and good at copying a number that is already
 * on the row, so the number is put there. Everything downstream - the anchoring,
 * the scope check, the "outside the diff" fallback - keys off `file` and `line`,
 * and this is what makes those two trustworthy enough to key off.
 *
 * Deletions carry no number because they have no right-hand line, and a comment
 * cannot be anchored to one. They are still shown: a review that cannot see what
 * was removed reports the same removal as a bug.
 */
export const renderHunk = (hunk: Hunk): string => {
  const rows = hunk.lines.map((line) => {
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    const number =
      line.right === undefined ? '     ' : String(line.right).padStart(5);
    return `${number} ${sign} ${line.text}`;
  });
  return [hunk.header, ...rows].join('\n');
};

export const renderFile = (file: DiffFile): string =>
  [
    `### ${file.path} (${file.status})`,
    '```diff',
    ...file.hunks.map(renderHunk),
    '```',
  ].join('\n');

/** Rough token count, for deciding when a diff has to be split into batches. */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4);

/**
 * Files grouped so no group is likely to overflow a context window.
 *
 * A file bigger than the budget on its own still goes out on its own rather than
 * being dropped or truncated: a model with a smaller window than the file will
 * refuse that one request, the router deranks, and the rest of the review still
 * happens. Silently reviewing half of a large file would not announce itself.
 */
export const batchFiles = (
  files: readonly DiffFile[],
  budgetTokens: number,
): readonly (readonly DiffFile[])[] => {
  const batches: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let used = 0;

  for (const file of files) {
    if (file.hunks.length === 0) continue;
    const cost = estimateTokens(renderFile(file));
    if (current.length > 0 && used + cost > budgetTokens) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(file);
    used += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
};
