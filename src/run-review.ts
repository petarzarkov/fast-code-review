/**
 * The review flow: a pull request in, one pull request review out.
 *
 * The order of the steps is load-bearing. Resolved threads are read before the
 * diff is batched, so lines the author has already closed are never sent to a
 * model at all - not filtered out of its answer afterwards. A model that is
 * shown the code will find something to say about it, and something to say about
 * a closed conversation is the one output there is no good way to discard.
 */
import { ask } from './ai.ts';
import type { Config } from './config.ts';
import {
  commentableLines,
  type DiffFile,
  estimateTokens,
  parseFiles,
} from './diff.ts';
import {
  gather,
  type GatheredFile,
  renderReference,
  renderWithContext,
} from './context.ts';
import { excluded } from './filter.ts';
import { type Finding, isStructured, parseVerdict } from './findings.ts';
import type { GitHub, PullRequest, ReviewThread } from './github.ts';
import { log } from './log.ts';
import { reviewSystemPrompt, reviewUserPrompt } from './prompts.ts';
import { buildReview, resolvedLines } from './review.ts';
import { scopeSince } from './scope.ts';

/**
 * Hunks are dropped only when **every** commentable line in them is closed.
 *
 * A hunk with one resolved line and nine live ones still has to be reviewed, and
 * the resolved line inside it is caught later by the duplicate check. Dropping
 * on any overlap would let one resolved comment blind the review to the rest of
 * the function it sits in.
 */
const withoutResolved = (
  files: readonly DiffFile[],
  resolved: ReadonlyMap<string, ReadonlySet<number>>,
): readonly DiffFile[] =>
  files.map((file) => {
    const closed = resolved.get(file.path);
    if (closed === undefined || closed.size === 0) return file;

    return {
      ...file,
      hunks: file.hunks.filter((hunk) => {
        const lines = hunk.lines
          .map((line) => line.right)
          .filter((line): line is number => line !== undefined);
        return lines.length === 0 || !lines.every((line) => closed.has(line));
      }),
    };
  });

/** Our own open threads, as the model needs to see them: what and where. */
const openThreadDigest = (
  threads: readonly ReviewThread[],
  mine: string,
): string | undefined => {
  const open = threads.filter(
    (thread) =>
      !thread.isResolved &&
      !thread.isOutdated &&
      thread.comments.some((comment) => comment.author === mine),
  );
  if (open.length === 0) return undefined;

  return open
    .map((thread) => {
      const first = thread.comments.find((comment) => comment.author === mine);
      const where = `${thread.path}${thread.line === null ? '' : `:${thread.line}`}`;
      // One line each. The full bodies of a dozen open threads would crowd out
      // the diff they are supposed to provide context for.
      return `- ${where}: ${(first?.body ?? '').split('\n')[0] ?? ''}`;
    })
    .join('\n');
};

export const runReview = async (
  github: GitHub,
  config: Config,
  pr: PullRequest,
): Promise<void> => {
  if (config.skipDrafts && pr.draft) {
    log.info(
      'Pull request is a draft and skip_draft_prs is on. Nothing to do.',
    );
    return;
  }

  const mine = await github.login();
  log.info(`Reviewing as ${mine}.`);

  const raw = await github.files(pr.owner, pr.repo, pr.number);
  const kept = raw.filter((file) => !excluded(file.filename, config.exclude));
  log.info(`${raw.length} changed file(s), ${kept.length} after exclusions.`);

  const threads = await github.threads(pr.owner, pr.repo, pr.number);
  const resolved = resolvedLines(threads, mine);
  const files = withoutResolved(parseFiles(kept), resolved).filter(
    (file) => file.hunks.length > 0,
  );

  if (files.length === 0) {
    log.info(
      'Nothing left to review once exclusions and resolved threads are applied.',
    );
    return;
  }

  const scope = await scopeSince(
    github,
    pr.owner,
    pr.repo,
    pr.number,
    pr.headSha,
  );

  const promptInput = {
    title: pr.title,
    description: pr.body,
    diff: '',
    language: config.language,
    instructions: config.instructions,
    openThreads: openThreadDigest(threads, mine),
  };
  const system = reviewSystemPrompt(promptInput);

  /**
   * The contents behind the diff, so the change is judged against the code
   * rather than against three lines of patch context either side of it.
   */
  const context = config.fullContext
    ? await gather(github, pr.owner, pr.repo, pr.headSha, files, {
        related: config.relatedFiles,
        relatedPerFile: 3,
        maxReferences: 12,
      })
    : {
        changed: files.map((file) => ({ file, content: undefined })),
        references: new Map<string, string>(),
      };

  const render = (entry: GatheredFile): string =>
    renderWithContext(entry.file, entry.content, {
      maxFileLines: config.maxFileLines,
      window: 45,
    });

  /**
   * Batched on rendered size rather than on the patch, because the rendering is
   * what is actually sent. A whole file is many times its patch, so batching the
   * patch and expanding it afterwards is how a context window gets overrun.
   */
  const batches = batchRendered(context.changed, render, config.batchTokens);

  /**
   * References ride with the first batch only. They are background for judging
   * the change, and repeating a dozen files across every batch spends the budget
   * on the same bytes instead of on more of the diff.
   */
  const referenceBlock = [...context.references]
    .map(([path, content]) => renderReference(path, content, 300))
    .join('\n\n');

  log.info(`Sending ${files.length} file(s) in ${batches.length} batch(es).`);

  const findings: Finding[] = [];
  let structured = false;
  let approve: boolean | undefined;
  const summaries: string[] = [];

  for (const [index, batch] of batches.entries()) {
    const answer = await log.group(
      `Batch ${index + 1}/${batches.length} (${batch.length} file(s))`,
      () =>
        ask(config.attempts, {
          json: true,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: reviewUserPrompt({
                ...promptInput,
                diff: [
                  ...batch.map(render),
                  ...(index === 0 && referenceBlock !== ''
                    ? [referenceBlock]
                    : []),
                ].join('\n\n'),
              }),
            },
          ],
        }),
    );

    const verdict = parseVerdict(answer.text);

    /**
     * One batch answering in a usable shape is enough to treat the run as a real
     * review. The alternative - requiring all of them - would refuse to approve a
     * clean diff because batch three came back as prose, and a review that cannot
     * approve is the failure this action is trying not to be.
     */
    if (isStructured(answer.text)) structured = true;
    else log.warn(`Batch ${index + 1} did not answer in JSON; ignoring it.`);

    findings.push(...verdict.findings);
    if (verdict.approve === false) approve = false;
    else approve ??= verdict.approve;
    if (verdict.summary !== undefined) summaries.push(verdict.summary);
  }

  const review = buildReview({
    findings,
    structured,
    approve,
    summary: summaries.length === 1 ? summaries[0] : undefined,
    commentable: commentableLines(files),
    scope,
    threads,
    mine,
    maxComments: config.maxComments,
  });

  /**
   * An approval the workflow did not ask for becomes a plain comment. A review
   * that can approve is also a review that can satisfy a required-reviewer rule,
   * and a repository may reasonably want the comments without granting the bot
   * that.
   */
  const event =
    review.event === 'APPROVE' && !config.approve ? 'COMMENT' : review.event;

  if (review.body === '' && review.comments.length === 0) {
    log.error('The model produced no review. Not posting an empty one.');
    process.exitCode = 1;
    return;
  }

  await github.submitReview(pr.owner, pr.repo, pr.number, pr.headSha, {
    ...review,
    event,
  });

  log.ok(
    `${event.toLowerCase()}: ${review.comments.length} inline, ` +
      `${review.carried} carried, ${review.duplicates} already open.`,
  );
};

/**
 * Groups rendered files so no group is likely to overrun a context window.
 *
 * A file larger than the budget still goes out on its own rather than being
 * dropped or truncated: a model with a smaller window refuses that one request,
 * the router deranks, and the rest of the review still happens. Silently
 * reviewing half of a large file would not announce itself.
 */
const batchRendered = (
  entries: readonly GatheredFile[],
  render: (entry: GatheredFile) => string,
  budgetTokens: number,
): readonly (readonly GatheredFile[])[] => {
  const batches: GatheredFile[][] = [];
  let current: GatheredFile[] = [];
  let used = 0;

  for (const entry of entries) {
    if (entry.file.hunks.length === 0) continue;
    const cost = estimateTokens(render(entry));
    if (current.length > 0 && used + cost > budgetTokens) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(entry);
    used += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
};
