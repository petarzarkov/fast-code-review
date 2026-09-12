import { describe, expect, test } from 'bun:test';
import { excluded, matches } from './filter.ts';

describe('matches', () => {
  test('a slashless pattern matches on the basename at any depth', () => {
    expect(matches('README.md', '*.md')).toBe(true);
    expect(matches('docs/deep/guide.md', '*.md')).toBe(true);
  });

  test('a single star stops at a separator', () => {
    expect(matches('dist/index.js', 'dist/*')).toBe(true);
    expect(matches('dist/nested/index.js', 'dist/*')).toBe(false);
  });

  test('a double star crosses separators', () => {
    expect(matches('dist/nested/deep/index.js', 'dist/**')).toBe(true);
  });

  test('a leading globstar also matches zero directories', () => {
    expect(matches('__snapshots__/a.snap', '**/__snapshots__/**')).toBe(true);
    expect(matches('src/__snapshots__/a.snap', '**/__snapshots__/**')).toBe(
      true,
    );
  });

  test('dots are literal, not the regex any-character', () => {
    expect(matches('packagexlock.json', 'package-lock.json')).toBe(false);
    expect(matches('package-lock.json', 'package-lock.json')).toBe(true);
  });

  test('a question mark matches one character but never a separator', () => {
    expect(matches('a.ts', '?.ts')).toBe(true);
    expect(matches('ab.ts', '?.ts')).toBe(false);
    expect(matches('a/b.ts', '?/b.ts')).toBe(true);
    expect(matches('a/b.ts', '?b.ts')).toBe(false);
  });

  test('a pattern with a slash is anchored and does not fall back to the basename', () => {
    expect(matches('src/vendor/lib.js', 'vendor/**')).toBe(false);
    expect(matches('vendor/lib.js', 'vendor/**')).toBe(true);
  });

  test('regex metacharacters in a filename are not treated as syntax', () => {
    expect(matches('a+b.ts', 'a+b.ts')).toBe(true);
    expect(matches('aab.ts', 'a+b.ts')).toBe(false);
  });
});

describe('excluded', () => {
  test('any pattern matching is enough', () => {
    expect(excluded('bun.lock', ['*.md', '*.lock'])).toBe(true);
    expect(excluded('src/main.ts', ['*.md', '*.lock'])).toBe(false);
  });

  test('an empty pattern list excludes nothing', () => {
    expect(excluded('anything.md', [])).toBe(false);
  });
});
