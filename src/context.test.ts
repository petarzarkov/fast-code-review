import { describe, expect, test } from 'bun:test';
import {
  importSpecs,
  relatedFor,
  renderWithContext,
  resolveImport,
  testPathFor,
  windowsFor,
} from './context.ts';
import type { DiffFile } from './diff.ts';
import { parsePatch } from './diff.ts';

const FILE = (patch: string, path = 'src/a.ts'): DiffFile => ({
  path,
  status: 'modified',
  hunks: [...parsePatch(patch)],
});

describe('renderWithContext', () => {
  const content = ['one', 'two', 'three', 'four', 'five'].join('\n');
  const file = FILE('@@ -2,2 +2,2 @@\n two\n-old three\n+three\n four');

  test('shows the whole file with the change marked inside it', () => {
    const out = renderWithContext(file, content);
    expect(out).toContain('Whole file at this commit');
    expect(out).toContain('    1   | one');
    expect(out).toContain('    2 = | two');
    expect(out).toContain('    3 + | three');
    // Line 5 is outside the diff but still shown: it is context to read, and
    // the blank marker is what says it cannot carry a comment.
    expect(out).toContain('    5   | five');
  });

  test('shows a deleted line with no number, since it cannot be commented on', () => {
    expect(renderWithContext(file, content)).toContain('     - | old three');
  });

  test('falls back to the patch when there are no contents', () => {
    const out = renderWithContext(file, undefined);
    expect(out).toContain('Contents unavailable');
    expect(out).toContain('+ three');
  });

  test('windows a large file instead of sending all of it', () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const late = FILE('@@ -200,1 +200,1 @@\n+changed');
    const out = renderWithContext(late, big, { maxFileLines: 100, window: 5 });
    expect(out).toContain('changed regions of the file');
    expect(out).toContain('line(s) not shown');
    expect(out).not.toContain('line 1\n');
  });
});

describe('windowsFor', () => {
  test('pads either side of a hunk and clamps to the file', () => {
    expect(windowsFor(FILE('@@ -10,1 +10,1 @@\n+x'), 100, 5)).toEqual([
      [5, 15],
    ]);
    expect(windowsFor(FILE('@@ -1,1 +1,1 @@\n+x'), 3, 5)).toEqual([[1, 3]]);
  });

  test('merges ranges that overlap or touch, so no empty gap marker appears', () => {
    const file: DiffFile = {
      path: 'a.ts',
      status: 'modified',
      hunks: [
        ...parsePatch('@@ -10,1 +10,1 @@\n+x'),
        ...parsePatch('@@ -14,1 +14,1 @@\n+y'),
      ],
    };
    expect(windowsFor(file, 100, 3)).toEqual([[7, 17]]);
  });
});

describe('importSpecs', () => {
  test('finds relative specifiers and ignores packages', () => {
    const content = [
      "import { a } from './a.js';",
      "import b from '../b/c.js';",
      "import zod from 'zod';",
      "const d = require('./d.js');",
    ].join('\n');
    expect(importSpecs(content)).toEqual(['./a.js', '../b/c.js', './d.js']);
  });
});

describe('resolveImport', () => {
  const tree = new Set(['src/a.ts', 'src/lib/b.ts', 'src/c/index.ts']);

  test('resolves a .js specifier to the .ts that emits it', () => {
    // Under nodenext a project writes the extension it emits, so matching the
    // literal specifier finds nothing in a repository that compiles.
    expect(resolveImport('src/x.ts', './a.js', tree)).toBe('src/a.ts');
  });

  test('resolves a directory to its index', () => {
    expect(resolveImport('src/x.ts', './c/index.js', tree)).toBe(
      'src/c/index.ts',
    );
    expect(resolveImport('src/x.ts', './c', tree)).toBe('src/c/index.ts');
  });

  test('walks up a relative path', () => {
    expect(resolveImport('src/deep/x.ts', '../lib/b.js', tree)).toBe(
      'src/lib/b.ts',
    );
  });

  test('is undefined for something not in the tree', () => {
    expect(resolveImport('src/x.ts', './nope.js', tree)).toBeUndefined();
  });
});

describe('testPathFor', () => {
  test('finds the sibling test file', () => {
    expect(testPathFor('src/a.ts', new Set(['src/a.test.ts']))).toBe(
      'src/a.test.ts',
    );
    expect(testPathFor('src/a.ts', new Set(['src/a.spec.ts']))).toBe(
      'src/a.spec.ts',
    );
  });

  test('finds a test in a __tests__ directory', () => {
    expect(testPathFor('src/a.ts', new Set(['src/__tests__/a.ts']))).toBe(
      'src/__tests__/a.ts',
    );
  });

  test('is undefined when nothing tests it', () => {
    expect(testPathFor('src/a.ts', new Set(['src/a.ts']))).toBeUndefined();
  });
});

describe('relatedFor', () => {
  test('puts the test first, then imports, and honours the limit', () => {
    const tree = new Set(['src/a.test.ts', 'src/b.ts', 'src/c.ts']);
    const content = "import './b.js';\nimport './c.js';";
    expect(relatedFor('src/a.ts', content, tree, 3)).toEqual([
      'src/a.test.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    expect(relatedFor('src/a.ts', content, tree, 2)).toHaveLength(2);
  });

  test('skips imports that do not resolve', () => {
    expect(relatedFor('src/a.ts', "import './gone.js';", new Set(), 3)).toEqual(
      [],
    );
  });
});
