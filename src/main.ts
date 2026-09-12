/**
 * The entry point: read the event, pick the flow, run it.
 *
 * Which flow runs is decided by the webhook payload rather than by an input,
 * because one `uses:` block in one workflow file should handle both triggers.
 * Asking a workflow author to wire `mode: review` and `mode: reply` into two jobs
 * is asking them to get it wrong once.
 */
import { loadConfig } from './config.ts';
import { GitHub, type PullRequest } from './github.ts';
import { log } from './log.ts';
import { type CommentEvent, runReply } from './run-reply.ts';
import { runReview } from './run-review.ts';

interface EventPayload {
  readonly pull_request?: {
    readonly number: number;
    readonly draft?: boolean;
  };
  readonly issue?: {
    readonly number: number;
    readonly pull_request?: unknown;
  };
  readonly comment?: {
    readonly id: number;
    readonly body: string;
    readonly in_reply_to_id?: number;
    readonly user?: { readonly login: string };
  };
  readonly sender?: { readonly login: string };
  readonly repository?: { readonly full_name: string };
}

const readEvent = async (): Promise<EventPayload> => {
  const path = process.env['GITHUB_EVENT_PATH'];
  if (path === undefined) {
    throw new Error('GITHUB_EVENT_PATH is not set; this must run in Actions.');
  }
  return (await Bun.file(path).json()) as EventPayload;
};

/** `owner/repo` from the environment, which is set for every event type. */
const repository = (): { readonly owner: string; readonly repo: string } => {
  const full = process.env['GITHUB_REPOSITORY'] ?? '';
  const [owner, repo] = full.split('/');
  if (owner === undefined || repo === undefined || repo === '') {
    throw new Error(`GITHUB_REPOSITORY is not owner/repo: "${full}"`);
  }
  return { owner, repo };
};

/**
 * The pull request number, wherever this event happens to keep it.
 *
 * `pull_request` events carry it at the top level and comment events carry it
 * under `issue`, and an `issue_comment` on an actual issue carries no
 * `pull_request` key at all - which is the case that has to be turned away
 * rather than followed into a 404.
 */
const pullNumber = (event: EventPayload): number | undefined => {
  if (event.pull_request?.number !== undefined)
    return event.pull_request.number;
  if (event.issue?.pull_request !== undefined) return event.issue.number;
  return undefined;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const event = await readEvent();
  const name = process.env['GITHUB_EVENT_NAME'] ?? '';
  const { owner, repo } = repository();

  log.info(
    `Event: ${name}. Routes planned: ${config.attempts.length} attempt(s).`,
  );
  for (const attempt of config.attempts) {
    log.debug(`  ${attempt.provider}/${attempt.model} key ${attempt.keyIndex}`);
  }

  const number = pullNumber(event);
  if (number === undefined) {
    log.info(`${name} is not about a pull request. Nothing to do.`);
    return;
  }

  const github = new GitHub(config.token);
  const pr: PullRequest = await github.pullRequest(owner, repo, number);

  if (name === 'pull_request_review_comment' && event.comment !== undefined) {
    const comment: CommentEvent = {
      id: event.comment.id,
      body: event.comment.body,
      sender: event.sender?.login ?? event.comment.user?.login ?? '',
      inReplyTo: event.comment.in_reply_to_id,
    };
    await runReply(github, config, pr, comment);
    return;
  }

  if (name === 'pull_request' || name === 'pull_request_target') {
    await runReview(github, config, pr);
    return;
  }

  /**
   * Anything else with a pull request attached - a `workflow_dispatch` pointed
   * at one, a `schedule` in a repository that re-reviews stale branches - gets a
   * review. Refusing unknown events would mean this action could only ever be
   * triggered the two ways its author thought of.
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
