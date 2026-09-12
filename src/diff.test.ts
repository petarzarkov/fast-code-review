import { describe, expect, test } from 'bun:test';
import {
  batchFiles,
  commentableLines,
  type DiffFile,
  parsePatch,
  renderHunk,
} from './diff.ts';

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  ' const e = 6;',
].join('\n');

describe('parsePatch', () => {
  test('numbers the right-hand side and leaves deletions unnumbered', () => {
    const [hunk] = parsePatch(PATCH);
    expect(hunk?.lines.map((line) => [line.kind, line.right])).toEqual([
      ['ctx', 1],
      ['del', undefined],
      ['add', 2],
      ['add', 3],
      ['ctx', 4],
      ['ctx', 5],
    ]);
  });

  test('a deletion does not advance the right-hand cursor', () => {
    const [hunk] = parsePatch('@@ -1,3 +1,1 @@\n-gone\n-also gone\n kept');
    expect(hunk?.lines.at(-1)?.right).toBe(1);
  });

  test('starts each hunk at the number in its own header', () => {
    const hunks = parsePatch(
      ['@@ -1,1 +1,1 @@', '+first', '@@ -50,1 +80,1 @@', '+later'].join('\n'),
    );
    expect(hunks.map((hunk) => hunk.lines[0]?.right)).toEqual([1, 80]);
  });

  test('a hunk header without line counts still parses', () => {
    const [hunk] = parsePatch('@@ -7 +9 @@\n+one');
    expect(hunk?.lines[0]?.right).toBe(9);
  });

  test('"no newline at end of file" is metadata, not a line', () => {
    const [hunk] = parsePatch(
      '@@ -1,1 +1,2 @@\n+one\n\\ No newline at end of file\n+two',
    );
    expect(hunk?.lines.map((line) => line.right)).toEqual([1, 2]);
  });

  test('a binary or oversized file has no patch and yields no hunks', () => {
    expect(parsePatch(undefined)).toEqual([]);
    expect(parsePatch('')).toEqual([]);
  });

  test('ignores anything before the first hunk header', () => {
    expect(parsePatch('some preamble\nmore preamble')).toEqual([]);
  });
});

describe('commentableLines', () => {
  test('offers added and context lines, which are the ones GitHub accepts', () => {
    const files: DiffFile[] = [
      { path: 'a.ts', status: 'modified', hunks: [...parsePatch(PATCH)] },
    ];
    expect(
      [...(commentableLines(files).get('a.ts') ?? [])].sort((x, y) => x - y),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test('a file with no hunks is present but offers nothing', () => {
    const files: DiffFile[] = [{ path: 'bin.png', status: 'added', hunks: [] }];
    expect(commentableLines(files).get('bin.png')?.size).toBe(0);
  });
});

describe('renderHunk', () => {
  test('prints the number the model is meant to cite back', () => {
    const [hunk] = parsePatch(PATCH);
    const rendered = renderHunk(hunk!);
    expect(rendered).toContain('    2 + const b = 3;');
    // A deletion gets blank space where a number would be, so there is nothing
    // to copy for a line that cannot be commented on.
    expect(rendered).toContain('      - const b = 2;');
  });
});

describe('batchFiles', () => {
  const file = (path: string, lines: number): DiffFile => ({
    path,
    status: 'modified',
    hunks: [
      {
        header: '@@ -1,1 +1,1 @@',
        lines: Array.from({ length: lines }, (_, index) => ({
          kind: 'add' as const,
          right: index + 1,
          text: 'x'.repeat(100),
        })),
      },
    ],
  });

  test('splits when the budget is reached', () => {
    const batches = batchFiles(
      [file('a', 50), file('b', 50), file('c', 50)],
      2_000,
    );
    expect(batches.length).toBeGreaterThan(1);
  });

  test('keeps everything in one batch when it fits', () => {
    const batches = batchFiles([file('a', 5), file('b', 5)], 100_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  test('a file larger than the budget still goes out, on its own', () => {
    const batches = batchFiles([file('big', 500)], 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.path).toBe('big');
  });

  test('drops files with nothing to review rather than batching empties', () => {
    const batches = batchFiles(
      [{ path: 'bin.png', status: 'added', hunks: [] }, file('a', 5)],
      100_000,
    );
    expect(batches[0]?.map((f) => f.path)).toEqual(['a']);
  });
});
