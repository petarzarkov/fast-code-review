/**
 * The entry point: read the event, pick the flow, run it.
 *
 * Which flow runs is decided by the webhook payload rather than by an input,
 * because one `uses:` block in one workflow file should handle every trigger.
 * Asking a workflow author to wire `mode: review`, `mode: reply` and
 * `mode: mention` into three jobs is asking them to get it wrong once.
 *
 * Three flows:
 *   review   a pull request event, or an explicit request
 *   reply    someone answered one of our own review comments
 *   mention  someone named us, in a comment, a review, or a thread
 */
import { loadConfig } from './config.ts';
import { GitHub, type PullRequest } from './github.ts';
import { log } from './log.ts';
import { defaultPhrase, mentions } from './mention.ts';
import { type MentionEvent, runMention } from './run-mention.ts';
import { type CommentEvent, runReply } from './run-reply.ts';
import { runReview } from './run-review.ts';

interface EventPayload {
  readonly pull_request?: { readonly number: number };
  readonly issue?: { readonly number: number; readonly pull_request?: unknown };
  readonly comment?: {
    readonly id: number;
    readonly body: string;
    readonly user?: { readonly login: string };
  };
  readonly review?: {
    readonly body: string | null;
    readonly user?: { readonly login: string };
  };
  readonly sender?: { readonly login: string };
}

const readEvent = async (): Promise<EventPayload> => {
  const path = process.env['GITHUB_EVENT_PATH'];
  if (path === undefined) {
    throw new Error('GITHUB_EVENT_PATH is not set; this must run in Actions.');
  }
  return (await Bun.file(path).json()) as EventPayload;
};

const repository = (): { readonly owner: string; readonly repo: string } => {
  const full = process.env['GITHUB_REPOSITORY'] ?? '';
  const [owner, repo] = full.split('/');
  if (owner === undefined || repo === undefined || repo === '') {
    throw new Error(`GITHUB_REPOSITORY is not owner/repo: "${full}"`);
  }
  return { owner, repo };
};

/**
 * The issue or pull request number, wherever this event keeps it.
 *
 * `pull_request` events carry it at the top level, comment events under
 * `issue`. An `issue_comment` on a real issue has an `issue` with no
 * `pull_request` key, and that is still a number worth having: the mention flow
 * answers on issues too, where there is no diff and never was one.
 */
const subjectNumber = (event: EventPayload): number | undefined =>
  event.pull_request?.number ?? event.issue?.number;

const senderOf = (event: EventPayload): string =>
  event.sender?.login ??
  event.comment?.user?.login ??
  event.review?.user?.login ??
  '';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const event = await readEvent();
  const name = process.env['GITHUB_EVENT_NAME'] ?? '';
  const { owner, repo } = repository();

  log.info(
    `Event: ${name}. Routes planned: ${config.attempts.length} attempt(s).`,
  );

  const number = subjectNumber(event);
  if (number === undefined) {
    log.info(`${name} is not about an issue or pull request. Nothing to do.`);
    return;
  }

  const github = new GitHub(config.token);
  const sender = senderOf(event);
  const phrase = config.triggerPhrase ?? defaultPhrase(await github.login());

  /**
   * A conversation comment or a submitted review, neither of which is worth a
   * model call unless we were named.
   *
   * `issue_comment` fires on every comment on every issue and every pull
   * request, so answering unconditionally would mean a run - and on a pull
   * request, a whole diff fetched and sent - for every remark anyone makes.
   * This gate is the reason wiring `issue_comment` is safe at all.
   */
  if (name === 'issue_comment' || name === 'pull_request_review') {
    const body = event.comment?.body ?? event.review?.body ?? '';
    if (!mentions(body, phrase)) {
      log.info(`No ${phrase} in the ${name}. Nothing to do.`);
      return;
    }
    const mention: MentionEvent = {
      number,
      body,
      sender,
      replyToCommentId: undefined,
    };
    await runMention(github, config, owner, repo, mention);
    return;
  }

  if (name === 'pull_request_review_comment' && event.comment !== undefined) {
    /**
     * A review comment is either thing. An explicit mention is a question put
     * to us wherever it lands, including a thread we have never spoken in;
     * without one, only a reply inside our own thread counts, which is what
     * `runReply` checks. Mention is tried first, so naming the bot always
     * works.
     */
    if (mentions(event.comment.body, phrase)) {
      await runMention(github, config, owner, repo, {
        number,
        body: event.comment.body,
        sender,
        replyToCommentId: event.comment.id,
      });
      return;
    }

    const pr: PullRequest = await github.pullRequest(owner, repo, number);
    const comment: CommentEvent = {
      id: event.comment.id,
      body: event.comment.body,
      sender,
    };
    await runReply(github, config, pr, comment);
    return;
  }

  const pr: PullRequest = await github.pullRequest(owner, repo, number);

  if (name === 'pull_request' || name === 'pull_request_target') {
    await runReview(github, config, pr);
    return;
  }

  /**
   * Anything else pointed at a pull request - a `workflow_dispatch`, a
   * `schedule` re-reviewing stale branches - is a review request. Every
   * conversational event is handled above, so nothing chatty reaches this.
   */
  log.info(`Treating ${name} as a review request.`);
  await runReview(github, config, pr);
};

try {
  await main();
} catch (error) {
  log.error(
    'fast-code-review failed',
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
}
