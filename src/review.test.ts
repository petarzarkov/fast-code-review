import { describe, expect, test } from 'bun:test';
import type { Finding } from './findings.ts';
import type { ReviewThread } from './github.ts';
import { buildReview, type BuildInput, resolvedLines } from './review.ts';

const MINE = 'reviewbot';

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: 'a.ts',
  line: 10,
  severity: 'concern',
  category: undefined,
  shortSummary: 'Off by one',
  summary: 'The loop runs one time too many.',
  failureScenario: undefined,
  suggestion: undefined,
  ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  isResolved: false,
  isOutdated: false,
  path: 'a.ts',
  line: 10,
  comments: [
    {
      id: 1,
      author: MINE,
      body: 'Off by one.',
      path: 'a.ts',
      line: 10,
      diffHunk: '',
    },
  ],
  ...over,
});

const build = (over: Partial<BuildInput> = {}) =>
  buildReview({
    findings: [],
    structured: true,
    approve: undefined,
    summary: undefined,
    commentable: new Map([['a.ts', new Set([10, 11, 12])]]),
    scope: null,
    threads: [],
    mine: MINE,
    maxComments: 20,
    ...over,
  });

describe('anchoring', () => {
  test('a finding on a line in the diff becomes an inline comment', () => {
    const review = build({ findings: [finding()] });
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({
      path: 'a.ts',
      line: 10,
      side: 'RIGHT',
    });
  });

  test('a finding outside the diff is summarised rather than posted', () => {
    // GitHub rejects the whole review if one comment names an uncommentable
    // line, so this case has to cost nothing rather than everything.
    const review = build({ findings: [finding({ line: 999 })] });
    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain('Outside the diff (1)');
  });

  test('a finding with no line at all is summarised', () => {
    const review = build({ findings: [finding({ line: undefined })] });
    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain('Outside the diff (1)');
  });

  test('a finding in a file that is not in the diff is summarised', () => {
    const review = build({ findings: [finding({ file: 'other.ts' })] });
    expect(review.comments).toHaveLength(0);
  });

  test('a single-line suggestion becomes a suggestion block', () => {
    const review = build({
      findings: [finding({ suggestion: 'const x = 1;' })],
    });
    expect(review.comments[0]?.body).toContain(
      '```suggestion\nconst x = 1;\n```',
    );
  });

  test('a multi-line suggestion is dropped, since GitHub would collapse it', () => {
    const review = build({ findings: [finding({ suggestion: 'a\nb' })] });
    expect(review.comments[0]?.body).not.toContain('suggestion');
  });
});

describe('the approval', () => {
  test('approves a structured, empty review', () => {
    expect(build().event).toBe('APPROVE');
    expect(build().body).toContain('nothing worth changing');
  });

  test('does not approve when the reply was never structured', () => {
    // An unparsed reply yields an empty findings list, which is vacuously clean.
    // Approving on it would approve on a refusal or a truncation.
    expect(build({ structured: false }).event).toBe('COMMENT');
  });

  test('does not approve when findings were posted, whatever the model said', () => {
    expect(build({ findings: [finding()], approve: true }).event).toBe(
      'COMMENT',
    );
  });

  test('does not approve when the model asked for a comment on an empty list', () => {
    expect(build({ approve: false }).event).toBe('COMMENT');
  });
});

describe('scope narrowing', () => {
  test('a finding in a file outside the scope is carried, not posted', () => {
    const review = build({
      findings: [finding(), finding({ file: 'b.ts', line: 10 })],
      scope: new Set(['a.ts']),
      commentable: new Map([
        ['a.ts', new Set([10])],
        ['b.ts', new Set([10])],
      ]),
    });
    expect(review.comments).toHaveLength(1);
    expect(review.carried).toBe(1);
    expect(review.body).toContain('untouched since the last review');
  });

  test('a null scope means the whole diff', () => {
    const review = build({ findings: [finding()], scope: null });
    expect(review.carried).toBe(0);
  });

  test('everything carried still approves, since nothing new was found', () => {
    const review = build({
      findings: [finding()],
      scope: new Set(['other.ts']),
    });
    expect(review.event).toBe('APPROVE');
    expect(review.body).toContain('found nothing new');
  });
});

describe('duplicate suppression', () => {
  test('a finding with an open thread of ours on the same line is not repeated', () => {
    const review = build({ findings: [finding()], threads: [thread()] });
    expect(review.comments).toHaveLength(0);
    expect(review.duplicates).toBe(1);
    expect(review.body).toContain('already');
  });

  test('a resolved thread does not suppress, because the line may have changed', () => {
    const review = build({
      findings: [finding()],
      threads: [thread({ isResolved: true })],
    });
    expect(review.comments).toHaveLength(1);
  });

  test('someone else’s thread does not suppress our finding', () => {
    const review = build({
      findings: [finding()],
      threads: [
        thread({
          comments: [
            {
              id: 2,
              author: 'someone',
              body: 'hm',
              path: 'a.ts',
              line: 10,
              diffHunk: '',
            },
          ],
        }),
      ],
    });
    expect(review.comments).toHaveLength(1);
  });

  test('a thread on a different line does not suppress', () => {
    const review = build({
      findings: [finding()],
      threads: [thread({ line: 11 })],
    });
    expect(review.comments).toHaveLength(1);
  });
});

describe('the comment cap', () => {
  test('keeps the worst findings and summarises the rest', () => {
    const commentable = new Map([['a.ts', new Set([1, 2, 3, 4])]]);
    const review = build({
      maxComments: 2,
      commentable,
      findings: [
        finding({ line: 1, severity: 'nit', shortSummary: 'nit one' }),
        finding({ line: 2, severity: 'nit', shortSummary: 'nit two' }),
        finding({ line: 3, severity: 'blocker', shortSummary: 'the blocker' }),
        finding({ line: 4, severity: 'concern', shortSummary: 'the concern' }),
      ],
    });

    expect(review.comments).toHaveLength(2);
    // Worst first, so a blocker arriving last is not cut for two nits.
    expect(review.comments.map((comment) => comment.line).sort()).toEqual([
      3, 4,
    ]);
    expect(review.body).toContain('Outside the diff (2)');
  });
});

describe('resolvedLines', () => {
  test('collects lines on resolved threads of ours', () => {
    const map = resolvedLines([thread({ isResolved: true })], MINE);
    expect([...(map.get('a.ts') ?? [])]).toEqual([10]);
  });

  test('ignores unresolved threads and other people’s threads', () => {
    expect(resolvedLines([thread()], MINE).size).toBe(0);
    expect(
      resolvedLines(
        [
          thread({
            isResolved: true,
            comments: [
              {
                id: 3,
                author: 'human',
                body: 'x',
                path: 'a.ts',
                line: 10,
                diffHunk: '',
              },
            ],
          }),
        ],
        MINE,
      ).size,
    ).toBe(0);
  });

  test('ignores a resolved thread that has lost its line', () => {
    expect(
      resolvedLines([thread({ isResolved: true, line: null })], MINE).size,
    ).toBe(0);
  });
});
