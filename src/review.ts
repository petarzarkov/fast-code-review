/**
 * Findings into one pull request review.
 *
 * One review per run, not a comment per finding: GitHub takes the inline
 * comments with the review in a single POST, so the conversation gets one entry
 * however many findings there were. The body stays a summary and the findings go
 * on the lines they are about, because the whole review in the body puts a
 * screen of prose in the conversation on every push.
 *
 * Everything in here is pure. The IO is in `github.ts` and the decision about
 * what may be reported is in `scope.ts`, which leaves this file as the part that
 * can be tested by calling it.
 */
import type { Finding } from './findings.ts';
import type { Commentable } from './diff.ts';
import type { ReviewThread } from './github.ts';
import type { Review, ReviewComment } from './github.ts';
import type { Scope } from './scope.ts';

export interface BuildInput {
  readonly findings: readonly Finding[];
  /** `undefined` when the model never produced a parseable answer. */
  readonly structured: boolean;
  readonly approve: boolean | undefined;
  readonly summary: string | undefined;
  readonly commentable: Commentable;
  readonly scope: Scope;
  /** Existing threads, so a finding already on the page is not posted twice. */
  readonly threads: readonly ReviewThread[];
  readonly mine: string;
  /** Most inline comments one review may post. The rest are listed in the body. */
  readonly maxComments: number;
}

export interface BuiltReview extends Review {
  /** Reportable, but about code untouched since the last review. */
  readonly carried: number;
  /** Already said in an open thread on the same line. */
  readonly duplicates: number;
}

/**
 * Worst first, so a cap that has to drop findings drops the ones that matter
 * least. A blocker arriving twenty-first and being cut for six nits is the one
 * ordering failure worth spending a comparator on.
 */
const RANK: Readonly<Record<string, number>> = Object.freeze({
  blocker: 0,
  concern: 1,
  nit: 2,
});

const bySeverity = (a: Finding, b: Finding): number =>
  (RANK[a.severity] ?? 1) - (RANK[b.severity] ?? 1);

const SEVERITY_MARK: Readonly<Record<string, string>> = Object.freeze({
  blocker: '🛑',
  concern: '⚠️',
  nit: '💬',
});

/**
 * A comment body: the claim, how it fails, and a one-click fix where the model
 * offered one.
 *
 * The suggestion block is only rendered when the finding names a single line.
 * GitHub applies a suggestion to the comment's line range, and a multi-line
 * replacement anchored to one line silently collapses the other lines into it.
 */
const body = (finding: Finding): string => {
  const mark = SEVERITY_MARK[finding.severity] ?? '💬';
  const tag = finding.category === undefined ? '' : ` \`${finding.category}\``;
  const parts = [`${mark}${tag} ${finding.summary}`];

  if (finding.failureScenario !== undefined) {
    parts.push(`**How it fails:** ${finding.failureScenario}`);
  }
  if (finding.suggestion !== undefined && !finding.suggestion.includes('\n')) {
    parts.push(`\`\`\`suggestion\n${finding.suggestion}\n\`\`\``);
  }

  return parts.join('\n\n');
};

const at = (finding: Finding): string =>
  `\`${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}\``;

/**
 * Whether an open thread of ours already says this, on this line.
 *
 * Only unresolved threads count. A resolved one means the author dealt with it,
 * and re-raising it is the treadmill; but a thread the author has replied to and
 * left open is a live conversation, and posting the same finding again next to
 * it is how the bot ends up arguing with itself.
 *
 * Matched on file and line rather than on text, because the model rewords the
 * same finding every run - which is precisely why text matching never caught it.
 */
const alreadyRaised = (
  finding: Finding,
  threads: readonly ReviewThread[],
  mine: string,
): boolean =>
  finding.line !== undefined &&
  threads.some(
    (thread) =>
      !thread.isResolved &&
      thread.path === finding.file &&
      thread.line === finding.line &&
      thread.comments.some((comment) => comment.author === mine),
  );

const carriedNote = (carried: number): string =>
  `${carried} further finding${carried === 1 ? '' : 's'} ` +
  `${carried === 1 ? 'is' : 'are'} in code untouched since the last review, ` +
  'and so were reportable then. Not repeated here.';

export const buildReview = (input: BuildInput): BuiltReview => {
  const { commentable, scope, threads, mine } = input;

  const inScope =
    scope === null
      ? input.findings
      : input.findings.filter((finding) => scope.has(finding.file));
  const carried = input.findings.length - inScope.length;

  const fresh = inScope.filter(
    (finding) => !alreadyRaised(finding, threads, mine),
  );
  const duplicates = inScope.length - fresh.length;

  const comments: ReviewComment[] = [];
  const elsewhere: Finding[] = [];

  for (const finding of [...fresh].sort(bySeverity)) {
    // Past the cap the finding is still reported, just in the body rather than
    // as its own comment: forty inline comments is a pull request nobody reads,
    // and a cheap model on a large diff produces forty far more readily than four.
    if (comments.length >= input.maxComments) {
      elsewhere.push(finding);
      continue;
    }
    const lines = commentable.get(finding.file);
    if (finding.line !== undefined && lines?.has(finding.line) === true) {
      comments.push({
        path: finding.file,
        line: finding.line,
        side: 'RIGHT',
        body: body(finding),
      });
    } else {
      // GitHub rejects the entire review if one comment names a line outside the
      // diff, so a finding about an untouched line is summarised in the body
      // rather than costing every other comment in the batch.
      elsewhere.push(finding);
    }
  }

  /**
   * Approving takes agreement from both signals.
   *
   * The model's own verdict alone would approve a review that listed five
   * findings and then said "approve", which smaller models do. An empty findings
   * list alone would approve a reply that was never structured to begin with -
   * a refusal, a truncation, or prose - because an empty list is vacuously
   * clean. Either signal saying there is something to fix withholds the approval.
   */
  const nothingFound = input.structured && fresh.length === 0;
  const event: Review['event'] =
    !input.structured || fresh.length > 0
      ? 'COMMENT'
      : input.approve === false
        ? 'COMMENT'
        : nothingFound
          ? 'APPROVE'
          : 'COMMENT';

  const lines: string[] = [];

  if (comments.length === 0 && elsewhere.length === 0) {
    lines.push(
      carried === 0 && duplicates === 0
        ? 'Reviewed the diff and found nothing worth changing.'
        : 'Reviewed what changed since the last review and found nothing new.',
    );
    if (input.summary !== undefined) lines.push('', input.summary);
  } else {
    const plural = comments.length === 1 ? 'comment' : 'comments';
    lines.push(`**Actionable ${plural} posted: ${comments.length}**`);
    if (input.summary !== undefined) lines.push('', input.summary);
  }

  if (carried > 0) lines.push('', carriedNote(carried));
  if (duplicates > 0) {
    lines.push(
      '',
      `${duplicates} finding${duplicates === 1 ? '' : 's'} already ` +
        `${duplicates === 1 ? 'has' : 'have'} an open thread on the same line. ` +
        'Not repeated here.',
    );
  }

  if (elsewhere.length > 0) {
    // Collapsed, so the conversation stays a summary rather than the review.
    lines.push(
      '',
      `<details><summary>Outside the diff (${elsewhere.length})</summary>`,
      '',
      ...elsewhere.map((finding) => `- ${at(finding)} ${finding.shortSummary}`),
      '',
      '</details>',
    );
  }

  return { event, body: lines.join('\n'), comments, carried, duplicates };
};

/**
 * Hunks whose findings the author has already dealt with.
 *
 * A resolved thread on a line means that conversation is over. Re-reviewing the
 * lines it covers produces the same finding worded differently, which reopens a
 * question the author closed - and is the single loudest way this action can
 * make itself worth turning off.
 */
export const resolvedLines = (
  threads: readonly ReviewThread[],
  mine: string,
): ReadonlyMap<string, ReadonlySet<number>> => {
  const map = new Map<string, Set<number>>();
  for (const thread of threads) {
    if (!thread.isResolved || thread.line === null) continue;
    if (!thread.comments.some((comment) => comment.author === mine)) continue;
    const lines = map.get(thread.path) ?? new Set<number>();
    lines.add(thread.line);
    map.set(thread.path, lines);
  }
  return map;
};
