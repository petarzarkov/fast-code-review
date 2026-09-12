import { describe, expect, test } from 'bun:test';
import { isStructured, parseVerdict } from './findings.ts';

const one = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    verdict: 'comment',
    findings: [{ file: 'a.ts', line: 4, summary: 'Off by one.', ...extra }],
  });

describe('parseVerdict', () => {
  test('reads the ordinary shape', () => {
    const { findings } = parseVerdict(one({ severity: 'blocker' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('a.ts');
    expect(findings[0]?.line).toBe(4);
    expect(findings[0]?.severity).toBe('blocker');
  });

  test('accepts a bare array, which smaller models return instead', () => {
    expect(
      parseVerdict('[{"file":"a.ts","line":1,"summary":"x"}]').findings,
    ).toHaveLength(1);
  });

  test('accepts the other keys a model reaches for', () => {
    expect(
      parseVerdict('{"reviews":[{"file":"a.ts","summary":"x"}]}').findings,
    ).toHaveLength(1);
    expect(
      parseVerdict('{"issues":[{"file":"a.ts","summary":"x"}]}').findings,
    ).toHaveLength(1);
  });

  test('unwraps a markdown fence', () => {
    expect(parseVerdict('```json\n{"findings":[]}\n```').findings).toEqual([]);
  });

  test('takes path and comment as aliases for file and summary', () => {
    const { findings } = parseVerdict('[{"path":"a.ts","comment":"x"}]');
    expect(findings[0]?.file).toBe('a.ts');
    expect(findings[0]?.summary).toBe('x');
  });

  test('a line arriving as a string or a range takes the first number', () => {
    expect(parseVerdict(one({ line: '42' })).findings[0]?.line).toBe(42);
    expect(parseVerdict(one({ line: '42-49' })).findings[0]?.line).toBe(42);
  });

  test('an unusable line is absent rather than zero', () => {
    expect(
      parseVerdict(one({ line: 'unknown' })).findings[0]?.line,
    ).toBeUndefined();
    expect(parseVerdict(one({ line: 0 })).findings[0]?.line).toBeUndefined();
  });

  test('an unknown severity falls back to concern rather than being dropped', () => {
    expect(
      parseVerdict(one({ severity: 'critical' })).findings[0]?.severity,
    ).toBe('concern');
  });

  test('drops an entry with no file or no summary', () => {
    expect(parseVerdict('[{"line":3,"summary":"x"}]').findings).toEqual([]);
    expect(parseVerdict('[{"file":"a.ts","line":3}]').findings).toEqual([]);
  });

  test('derives a short summary from the first sentence when none is given', () => {
    const { findings } = parseVerdict(
      one({ summary: 'First thing. Second thing.' }),
    );
    expect(findings[0]?.shortSummary).toBe('First thing.');
  });

  test('an empty findings array approves even without a verdict field', () => {
    expect(parseVerdict('{"findings":[]}').approve).toBe(true);
  });

  test('an explicit comment verdict wins over an empty array', () => {
    expect(parseVerdict('{"verdict":"comment","findings":[]}').approve).toBe(
      false,
    );
  });

  test('prose parses to nothing rather than throwing', () => {
    const verdict = parseVerdict(
      'I reviewed the diff and it looks fine to me.',
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.approve).toBeUndefined();
  });
});

describe('isStructured', () => {
  test('tells an empty answer apart from a missing one', () => {
    expect(isStructured('{"findings":[]}')).toBe(true);
    expect(isStructured('[]')).toBe(true);
    // The distinction the approval rests on: prose is not a clean review.
    expect(isStructured('Looks good to me!')).toBe(false);
    expect(isStructured('{"summary":"fine"}')).toBe(false);
  });
});
