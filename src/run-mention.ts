/**
 * The mention flow: someone named this bot in a comment, so answer them.
 *
 * This is the third of the three things the action does, and the loosest. A
 * review has a schema and a threshold; a mention is a person asking a question
 * in prose, and the answer is prose back.
 *
 * What it deliberately does not do is act. It has no checkout, no file access
 * and no way to push a commit, so a request to fix something gets the fix as a
 * diff in the reply rather than a branch. That boundary is in the prompt as
 * well, because a model in this position will otherwise describe changes to
 * code it never read.
 */
import { ask } from './ai.ts';
import type { Config } from './config.ts';
import { batchFiles, parseFiles, renderFile } from './diff.ts';
import { excluded } from './filter.ts';
import type { GitHub, IssueComment, ReviewThread } from './github.ts';
import { log } from './log.ts';
import { mentionSystemPrompt, mentionUserPrompt } from './prompts.ts';

export interface MentionEvent {
  /** The issue or pull request the comment sits on. */
  readonly number: number;
  readonly body: string;
  readonly sender: string;
  /**
   * The review thread to answer in, when the mention arrived on one. Absent for
   * a conversation comment or a submitted review, which are answered at the
   * bottom of the conversation instead.
   */
  readonly replyToCommentId: number | undefined;
}

/**
 * The conversation, oldest first, with the bot's own turns marked.
 *
 * Marked rather than filtered: an answer that cannot see what it already said
 * repeats itself, and repeating itself at someone who just asked a follow-up is
 * the thing that reads as a bot.
 */
const renderConversation = (
  openingAuthor: string,
  openingBody: string,
  comments: readonly IssueComment[],
  mine: string,
  thread: ReviewThread | undefined,
  asked: string,
): string => {
  const who = (author: string): string =>
    author === mine ? `${author} (you)` : author;

  const lines = [
    `**${who(openingAuthor)}** opened it:`,
    openingBody === '' ? '_No description._' : openingBody,
    ...comments.map(
      (comment) => `\n**${who(comment.author)}:**\n${comment.body}`,
    ),
  ];

  if (thread !== undefined) {
    const where = `${thread.path}${thread.line === null ? '' : `:${thread.line}`}`;
    lines.push(
      `\n---\n\nThe mention is in a review thread on ${where}, about this code:`,
      '\n```diff',
      thread.comments[0]?.diffHunk ?? '(no longer available)',
      '```',
      '\nThe thread, oldest first:',
      ...thread.comments.map(
        (comment) => `\n**${who(comment.author)}:**\n${comment.body}`,
      ),
    );
  }

  /**
   * Restated last and labelled, rather than left to be found.
   *
   * It is already above, once the thread is included, but which of a dozen
   * comments is the live question is exactly what a model gets wrong when the
   * conversation is long - and the answer to the wrong one still reads fluent.
   */
  lines.push(
    `\n---\n\n**This is the message that mentioned you. Answer it:**\n${asked}`,
  );

  return lines.join('\n');
};

/**
 * The diff, when the mention is on a pull request and it is small enough to
 * carry.
 *
 * One batch only. A question about a 200-file pull request is not answered any
 * better by pushing all of it through a free-tier context window, and truncating
 * silently would be worse than saying the diff was too large: the prompt tells
 * the model to name what it could not see rather than guess, and this is the
 * case that makes that instruction true.
 */
const diffFor = async (
  github: GitHub,
  config: Config,
  owner: string,
  repo: string,
  number: number,
): Promise<string | undefined> => {
  const raw = await github.files(owner, repo, number);
  const files = parseFiles(
    raw.filter((file) => !excluded(file.filename, config.exclude)),
  );
  const batches = batchFiles(files, config.batchTokens);
  const first = batches[0];
  if (first === undefined) return undefined;

  const rendered = first.map(renderFile).join('\n\n');
  return batches.length === 1
    ? rendered
    : `${rendered}\n\n_(${batches.length - 1} further batch(es) of this diff are not shown.)_`;
};

export const runMention = async (
  github: GitHub,
  config: Config,
  owner: string,
  repo: string,
  event: MentionEvent,
): Promise<void> => {
  const mine = await github.login();

  // The loop guard. This posts with a real account's token, so its own comments
  // raise the very events that trigger it.
  if (event.sender === mine) {
    log.info('The comment is our own. Not answering ourselves.');
    return;
  }

  const issue = await github.issue(owner, repo, event.number);
  const comments = await github.issueComments(owner, repo, event.number);

  /**
   * The review thread the mention arrived in, when it arrived in one.
   *
   * `/issues/{n}/comments` returns **only** top-level conversation comments.
   * Review comments are a separate resource, so a mention left on a line of the
   * diff appeared nowhere in the context gathered above: the model was handed a
   * pull request and a diff, with no question anywhere in it, and did the only
   * thing that made sense with that - it reviewed the diff. Twice, on two
   * different models, which is what made it look like a prompt problem.
   */
  const thread =
    event.replyToCommentId === undefined
      ? undefined
      : (await github.threads(owner, repo, event.number)).find((candidate) =>
          candidate.comments.some(
            (comment) => comment.id === event.replyToCommentId,
          ),
        );

  const diff = issue.isPullRequest
    ? await diffFor(github, config, owner, repo, event.number)
    : undefined;

  const promptInput = {
    subject: issue.title,
    kind: issue.isPullRequest ? ('pull request' as const) : ('issue' as const),
    conversation: renderConversation(
      issue.author,
      issue.body,
      comments,
      mine,
      thread,
      event.body,
    ),
    diff,
    language: config.language,
    instructions: config.instructions,
  };

  const answer = await ask(config.answerAttempts, {
    maxTokens: 2_048,
    temperature: 0.3,
    messages: [
      { role: 'system', content: mentionSystemPrompt(promptInput) },
      { role: 'user', content: mentionUserPrompt(promptInput) },
    ],
  });

  const body = answer.text.trim();
  if (body === '') {
    log.warn('The model returned an empty answer. Not posting it.');
    return;
  }

  if (event.replyToCommentId !== undefined) {
    await github.replyToComment(
      owner,
      repo,
      event.number,
      event.replyToCommentId,
      body,
    );
    log.ok(`Answered in review thread on #${event.number}.`);
    return;
  }

  await github.comment(owner, repo, event.number, body);
  log.ok(`Answered on #${event.number}.`);
};
