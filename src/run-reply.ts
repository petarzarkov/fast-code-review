/**
 * The reply flow: someone answered one of our review comments, so answer them.
 *
 * This is the half that makes the action a reviewer rather than a linter with a
 * bigger vocabulary. A finding the author disagrees with is a question, and a
 * reviewer that cannot be asked one leaves the author with two options - do what
 * it said, or resolve the thread and hope.
 *
 * The loop guard is the important detail here in a way it is not in the review
 * flow. This action posts with a real account's token, so its own replies raise
 * the same `pull_request_review_comment` event that triggered it. Without the
 * sender check it answers itself, and each answer triggers another.
 */
import { ask } from './ai.ts';
import type { Config } from './config.ts';
import type { GitHub, PullRequest, ReviewThread } from './github.ts';
import { log } from './log.ts';
import { replySystemPrompt, replyUserPrompt } from './prompts.ts';

export interface CommentEvent {
  readonly id: number;
  readonly body: string;
  readonly sender: string;
  readonly inReplyTo: number | undefined;
}

/** The thread containing a given comment. */
const threadOf = (
  threads: readonly ReviewThread[],
  commentId: number,
): ReviewThread | undefined =>
  threads.find((thread) =>
    thread.comments.some((comment) => comment.id === commentId),
  );

/**
 * The thread rendered for the model: the code it is about, then who said what.
 *
 * The diff hunk comes from the thread's first comment, which is where GitHub
 * stores the code a review comment was anchored to. Without it the model is
 * answering a question about code it cannot see, and the answer it gives is a
 * generality.
 */
const render = (thread: ReviewThread, mine: string): string => {
  const anchor = thread.comments[0];
  const where = `${thread.path}${thread.line === null ? '' : `:${thread.line}`}`;

  return [
    `The thread is on ${where}.`,
    '',
    '```diff',
    anchor?.diffHunk ?? '(the anchored code is no longer available)',
    '```',
    '',
    ...thread.comments.map(
      (comment) =>
        `**${comment.author === mine ? `${comment.author} (you)` : comment.author}:**\n${comment.body}`,
    ),
  ].join('\n');
};

export const runReply = async (
  github: GitHub,
  config: Config,
  pr: PullRequest,
  event: CommentEvent,
): Promise<void> => {
  if (!config.replies) {
    log.info('reply_to_threads is off. Nothing to do.');
    return;
  }

  const mine = await github.login();

  if (event.sender === mine) {
    log.info('The comment is our own. Not replying to ourselves.');
    return;
  }

  const threads = await github.threads(pr.owner, pr.repo, pr.number);
  const thread = threadOf(threads, event.id);

  if (thread === undefined) {
    log.info('Could not find the thread for this comment. Nothing to do.');
    return;
  }

  /**
   * Answer only where we already spoke.
   *
   * A reply in a thread between two humans is not addressed to this action, and
   * joining it uninvited is how a review bot becomes something a team mutes.
   * `in_reply_to` is not enough on its own: it says the comment is a reply, not
   * that it is a reply to *us*.
   */
  if (!thread.comments.some((comment) => comment.author === mine)) {
    log.info('Not our thread. Nothing to do.');
    return;
  }

  if (thread.isResolved) {
    log.info('The thread is resolved. Leaving it closed.');
    return;
  }

  /**
   * The last word has to be theirs. A run triggered while our own reply is the
   * most recent comment would answer a conversation nobody has added to - which
   * happens whenever two events for the same thread arrive close together.
   */
  const last = thread.comments.at(-1);
  if (last === undefined || last.author === mine) {
    log.info('We already had the last word in this thread. Nothing to do.');
    return;
  }

  const answer = await ask(config.attempts, {
    maxTokens: 1_024,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: replySystemPrompt({
          title: pr.title,
          thread: '',
          language: config.language,
        }),
      },
      {
        role: 'user',
        content: replyUserPrompt({
          title: pr.title,
          thread: render(thread, mine),
          language: config.language,
        }),
      },
    ],
  });

  const body = answer.text.trim();
  if (body === '') {
    log.warn('The model returned an empty reply. Not posting it.');
    return;
  }

  // Addressed to the thread's first comment, because that is the id GitHub's
  // replies endpoint takes - replying to a reply is not a thing it supports.
  const anchor = thread.comments[0];
  if (anchor === undefined) {
    log.warn('The thread has no anchor comment. Not replying.');
    return;
  }

  await github.replyToComment(pr.owner, pr.repo, pr.number, anchor.id, body);
  log.ok(`Replied in ${thread.path}:${thread.line ?? '?'}.`);
};
