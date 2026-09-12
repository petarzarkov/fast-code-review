import { describe, expect, test } from 'bun:test';
import { COMPARE_FILE_CAP, scopeFromCompare } from './scope.ts';

describe('scopeFromCompare', () => {
  test('a short list narrows the review to those files', () => {
    const scope = scopeFromCompare(['a.ts', 'b.ts']);
    expect(scope?.has('a.ts')).toBe(true);
    expect(scope?.has('c.ts')).toBe(false);
  });

  test('an empty compare narrows to nothing, which is a review of nothing new', () => {
    expect(scopeFromCompare([])?.size).toBe(0);
  });

  test('a list at the API cap widens to the whole diff rather than narrowing', () => {
    // The list may have been truncated, and a finding suppressed because its
    // file fell off the end is the exact failure this narrowing exists to stop.
    const capped = Array.from(
      { length: COMPARE_FILE_CAP },
      (_, i) => `f${i}.ts`,
    );
    expect(scopeFromCompare(capped)).toBeNull();
  });

  test('one file below the cap still narrows', () => {
    const under = Array.from(
      { length: COMPARE_FILE_CAP - 1 },
      (_, i) => `f${i}.ts`,
    );
    expect(scopeFromCompare(under)).not.toBeNull();
  });
});
