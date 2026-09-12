/**
 * What this review is allowed to report on.
 *
 * `null` means the whole diff, which is the first review of a pull request.
 * Every review after it sees only the files touched since this account's
 * previous one.
 *
 * **This is what lets a pull request converge.** The model sees the full diff on
 * every push and is not deterministic over it, so untouched code gets a fresh
 * chance to yield a finding on every run. Without narrowing, a pull request can
 * take five rounds and two dozen findings and still never be approved, because
 * there is always something new to say about code nobody has changed - and each
 * new thing was equally true and equally reportable in round one.
 *
 * Findings outside the scope are counted in the review body rather than dropped
 * in silence. They are real, and hiding them would be this file deciding what
 * the author is allowed to see.
 */
import type { GitHub } from './github.ts';
import { log } from './log.ts';

export type Scope = ReadonlySet<string> | null;

/**
 * `compare` returns at most this many files and does not page past them, so a
 * longer list has been truncated without saying so.
 */
export const COMPARE_FILE_CAP = 300;

/**
 * The scope a compare result supports, or `null` when it cannot be trusted.
 *
 * Suppressing a finding because its file fell off the end of a truncated list is
 * exactly the failure this narrowing exists to prevent: a genuinely new problem,
 * filed under "not repeated here", on a review that then approves. Being wrong
 * about the cap is only safe downwards - too low reviews more than it needs to.
 */
export const scopeFromCompare = (touched: readonly string[]): Scope =>
  touched.length >= COMPARE_FILE_CAP ? null : new Set(touched);

/** The commit this account last posted a review against, if it has. */
export const lastReviewedSha = async (
  github: GitHub,
  owner: string,
  repo: string,
  number: number,
): Promise<string | undefined> => {
  const me = await github.login();
  const reviews = await github.reviews(owner, repo, number);
  return reviews.findLast((review) => review.user?.login === me)?.commit_id;
};

/**
 * The files touched since this account last looked, or `null` when it has not.
 *
 * Both failure modes widen rather than narrow. A compare that fails - the old
 * commit garbage-collected after a force-push, most likely - and a response at
 * the file cap both fall back to the whole diff. Reviewing too much is the
 * behaviour being fixed; reviewing nothing in silence would be worse than the
 * bug.
 */
export const scopeSince = async (
  github: GitHub,
  owner: string,
  repo: string,
  number: number,
  head: string,
): Promise<Scope> => {
  const since = await lastReviewedSha(github, owner, repo, number);
  if (since === undefined || since === head) {
    log.info('First review of this pull request; reviewing the whole diff.');
    return null;
  }

  const touched = await github.compare(owner, repo, since, head);
  if (touched === undefined) {
    log.info(
      `Could not compare ${since.slice(0, 7)}...${head.slice(0, 7)}; ` +
        'reviewing the whole diff.',
    );
    return null;
  }

  const scope = scopeFromCompare(touched);
  log.info(
    scope === null
      ? `Compare returned ${touched.length} files, at or past the ` +
          `${COMPARE_FILE_CAP} the API caps at, so the list may be short. ` +
          'Reviewing the whole diff.'
      : `Reviewing ${touched.length} file(s) changed since ${since.slice(0, 7)}.`,
  );
  return scope;
};
