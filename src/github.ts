/**
 * GitHub's REST and GraphQL APIs over `fetch`, and nothing else.
 *
 * No Octokit. The action is a composite that runs its own source with Bun, so
 * every dependency is a `bun install` on the runner before any work starts, and
 * what Octokit is being asked for here is a bearer header, pagination and
 * `JSON.parse`. Zero dependencies makes the composite two steps instead of
 * three, and takes the lockfile out of the runtime path entirely.
 */
import { log } from './log.ts';

const API = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';
const GRAPHQL =
  process.env['GITHUB_GRAPHQL_URL'] ?? 'https://api.github.com/graphql';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface PullRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseSha: string;
  readonly author: string;
}

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: 'RIGHT';
  readonly body: string;
}

export interface Review {
  readonly event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
  readonly body: string;
  readonly comments: readonly ReviewComment[];
}

/** One comment in a review thread, flattened to what a prompt needs. */
export interface ThreadComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly path: string;
  readonly line: number | null;
  readonly diffHunk: string;
}

/** An issue or a pull request conversation, which share one REST resource. */
export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  /** GitHub models a pull request as an issue, so this is how they are told apart. */
  readonly isPullRequest: boolean;
}

export interface IssueComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface ReviewThread {
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly comments: readonly ThreadComment[];
}

export class GitHub {
  #login: string | undefined;

  constructor(private readonly token: string) {}

  async #request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ readonly data: T; readonly link: string | null }> {
    const response = await fetch(
      path.startsWith('http') ? path : `${API}${path}`,
      {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'fast-code-review',
          ...(init.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      },
    );

    const raw = await response.text();
    if (!response.ok) {
      throw new GitHubError(
        `${init.method ?? 'GET'} ${path} -> ${response.status}: ${raw.slice(0, 500)}`,
        response.status,
      );
    }

    return {
      data: (raw === '' ? undefined : JSON.parse(raw)) as T,
      link: response.headers.get('link'),
    };
  }

  async rest<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.#request<T>(path, init)).data;
  }

  /**
   * Every page of a list endpoint, followed by the `link` header rather than by
   * counting: a pull request with 130 changed files silently reviews the first
   * 30 otherwise, and reports an approval on the strength of it.
   */
  async paginate<T>(path: string): Promise<readonly T[]> {
    const all: T[] = [];
    let next: string | null =
      `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;

    while (next !== null) {
      const page: { data: readonly T[]; link: string | null } =
        await this.#request<readonly T[]>(next);
      all.push(...page.data);
      next = /<([^>]+)>;\s*rel="next"/.exec(page.link ?? '')?.[1] ?? null;
    }

    return all;
  }

  async graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const response = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'user-agent': 'fast-code-review',
      },
      body: JSON.stringify({ query, variables }),
    });

    const body = (await response.json()) as {
      data?: T;
      errors?: readonly { message: string }[];
    };

    if (!response.ok || body.errors !== undefined) {
      throw new GitHubError(
        body.errors?.map((error) => error.message).join('; ') ??
          `GraphQL ${response.status}`,
        response.status,
      );
    }

    return body.data as T;
  }

  /**
   * The login this action posts as.
   *
   * Resolved from the token rather than hardcoded, because the same code runs
   * under a personal access token belonging to a bot account and under the
   * workflow's own `GITHUB_TOKEN`. Everything that asks "is this mine?" - the
   * loop guard, the scope narrowing, which threads to answer - keys off this,
   * and a wrong answer either reviews nothing or answers itself forever.
   *
   * `GET /user` is not available to `GITHUB_TOKEN`, which is an installation
   * token rather than a user one, so a 403 there means exactly one thing.
   */
  async login(): Promise<string> {
    if (this.#login !== undefined) return this.#login;
    try {
      const user = await this.rest<{ login: string }>('/user');
      this.#login = user.login;
    } catch (error) {
      if (
        error instanceof GitHubError &&
        (error.status === 403 || error.status === 401)
      ) {
        this.#login = 'github-actions[bot]';
        log.debug('Token is not a user token; assuming github-actions[bot].');
      } else {
        throw error;
      }
    }
    return this.#login;
  }

  async pullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequest> {
    const pr = await this.rest<{
      title: string;
      body: string | null;
      draft: boolean;
      head: { sha: string };
      base: { sha: string };
      user: { login: string } | null;
    }>(`/repos/${owner}/${repo}/pulls/${number}`);

    return {
      owner,
      repo,
      number,
      title: pr.title,
      body: pr.body ?? '',
      draft: pr.draft,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      author: pr.user?.login ?? 'unknown',
    };
  }

  files(
    owner: string,
    repo: string,
    number: number,
  ): Promise<readonly { filename: string; status: string; patch?: string }[]> {
    return this.paginate(`/repos/${owner}/${repo}/pulls/${number}/files`);
  }

  reviews(
    owner: string,
    repo: string,
    number: number,
  ): Promise<readonly { user: { login: string } | null; commit_id: string }[]> {
    return this.paginate(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
  }

  /**
   * Review threads with their resolution status, which only GraphQL reports.
   *
   * REST has no notion of a thread being resolved - `pulls/comments` returns the
   * comments and nothing about the box someone ticked above them - so the
   * previous approach was guessing from thumbs-up reactions and replies that say
   * "done". That guess is wrong in both directions, and it decides whether a
   * finding gets repeated at the author for a fourth time.
   */
  async threads(
    owner: string,
    repo: string,
    number: number,
  ): Promise<readonly ReviewThread[]> {
    const query = `
      query Threads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              nodes {
                isResolved
                isOutdated
                path
                line
                comments(first: 50) {
                  nodes {
                    databaseId
                    body
                    path
                    line
                    diffHunk
                    author { login }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`;

    interface Page {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: readonly {
              isResolved: boolean;
              isOutdated: boolean;
              path: string;
              line: number | null;
              comments: {
                nodes: readonly {
                  databaseId: number;
                  body: string;
                  path: string;
                  line: number | null;
                  diffHunk: string;
                  author: { login: string } | null;
                }[];
              };
            }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    }

    const all: ReviewThread[] = [];
    let cursor: string | null = null;

    for (;;) {
      const page: Page = await this.graphql<Page>(query, {
        owner,
        repo,
        number,
        cursor,
      });
      const { nodes, pageInfo } = page.repository.pullRequest.reviewThreads;

      for (const node of nodes) {
        all.push({
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          path: node.path,
          line: node.line,
          comments: node.comments.nodes.map((comment) => ({
            id: comment.databaseId,
            author: comment.author?.login ?? 'unknown',
            body: comment.body,
            path: comment.path,
            line: comment.line,
            diffHunk: comment.diffHunk,
          })),
        });
      }

      if (!pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }

    return all;
  }

  /** Files changed between two commits, or `undefined` if they cannot be compared. */
  async compare(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<readonly string[] | undefined> {
    try {
      const result = await this.rest<{
        files?: readonly { filename: string }[];
      }>(`/repos/${owner}/${repo}/compare/${base}...${head}`);
      return (result.files ?? []).map((file) => file.filename);
    } catch (error) {
      log.debug(`Could not compare ${base}...${head}.`, error);
      return undefined;
    }
  }

  /**
   * The issue or pull request conversation, whichever this number names.
   *
   * `/issues/{n}` answers for both, and a pull request's payload carries a
   * `pull_request` key that an issue's does not. That key is the only reliable
   * way to tell them apart, and the mention flow needs to know: a pull request
   * mention gets the diff as context, an issue mention has no diff to get.
   */
  async issue(owner: string, repo: string, number: number): Promise<Issue> {
    const data = await this.rest<{
      title: string;
      body: string | null;
      user: { login: string } | null;
      pull_request?: unknown;
    }>(`/repos/${owner}/${repo}/issues/${number}`);

    return {
      number,
      title: data.title,
      body: data.body ?? '',
      author: data.user?.login ?? 'unknown',
      isPullRequest: data.pull_request !== undefined,
    };
  }

  /** The conversation timeline: top-level comments, not review threads. */
  async issueComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<readonly IssueComment[]> {
    const data = await this.paginate<{
      id: number;
      body: string | null;
      created_at: string;
      user: { login: string } | null;
    }>(`/repos/${owner}/${repo}/issues/${number}/comments`);

    return data.map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.created_at,
    }));
  }

  async submitReview(
    owner: string,
    repo: string,
    number: number,
    commitSha: string,
    review: Review,
  ): Promise<void> {
    await this.rest(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ commit_id: commitSha, ...review }),
    });
  }

  /** A reply inside an existing review thread, addressed by its first comment. */
  async replyToComment(
    owner: string,
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.rest(
      `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
  }

  async comment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    await this.rest(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
}
