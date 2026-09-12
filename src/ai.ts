/**
 * One OpenAI-compatible `POST /chat/completions`, walked down a list of attempts
 * until one answers.
 *
 * There is no SDK here and no per-provider subclass, because there is no
 * per-provider behaviour: OpenRouter, Groq, Gemini's compatibility endpoint,
 * DeepSeek and a self-hosted vLLM all take the same body on the same path. What
 * differs between them is the base URL and the key, and those are data.
 *
 * Structured output goes through `response_format: { type: 'json_object' }` and
 * a schema described in the prompt, rather than the strict `json_schema` mode.
 * Strict mode is the better tool where it exists, but most free-tier models
 * reject it outright, and a review that only runs on paid models is not the
 * review this action is for. `json_object` promises valid JSON and nothing about
 * its shape, so the parse is what actually guarantees the shape.
 */
import { type Attempt, describe } from './routes.ts';
import { log } from './log.ts';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

interface ChatResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }[];
  readonly error?: { readonly message?: string };
}

export interface AskOptions {
  readonly messages: readonly ChatMessage[];
  /** Ask for `json_object` and expect the reply to parse. */
  readonly json?: boolean;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/** Which attempt answered, so the run log and the review body can say so. */
export interface Answer {
  readonly text: string;
  readonly attempt: Attempt;
}

/**
 * How long one model call may take before the next attempt is tried instead.
 *
 * A free tier under load does not refuse, it queues, and a queued request holds
 * the socket open well past the point where a different key would have answered
 * already. The runner's own job timeout is the only other bound, and reaching
 * that means the whole review is lost rather than one attempt.
 */
const TIMEOUT_MS = 120_000;

/** A retry inside one attempt, for a fault that is plainly the server's. */
const RETRY_BACKOFF_MS = 2_000;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly attempt: Attempt,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * A rate limit or an exhausted quota, by status or by what the body says.
 *
 * The message test is there because providers disagree about the status: a spent
 * Gemini free tier answers 429, some gateways answer 200 with an error object,
 * and OpenRouter answers 402 when a paid model is routed to with no credit.
 */
const isQuota = (status: number | undefined, message: string): boolean =>
  status === 429 ||
  status === 402 ||
  /\b(429|402)\b|quota|rate.?limit|too.?many|exhaust|insufficient|credit/i.test(
    message,
  );

/** A key that will never work: wrong, revoked, or not entitled to this model. */
const isAuth = (status: number | undefined): boolean =>
  status === 401 || status === 403;

/** The server's fault, so the same key is worth one more try. */
const isTransient = (status: number | undefined): boolean =>
  status === undefined || status === 408 || status === 409 || status >= 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request to one attempt. Throws `ProviderError` for anything that should
 * move the router on.
 */
const callOnce = async (
  attempt: Attempt,
  options: AskOptions,
): Promise<string> => {
  const response = await fetch(`${attempt.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${attempt.apiKey}`,
      // OpenRouter attributes requests to a project with these two and rejects
      // neither when they are absent; every other provider ignores them.
      'http-referer': 'https://github.com/petarzarkov/fast-code-review',
      'x-title': 'fast-code-review',
    },
    body: JSON.stringify({
      model: attempt.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 8_192,
      ...(options.json === true
        ? { response_format: { type: 'json_object' } }
        : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new ProviderError(
      `HTTP ${response.status}: ${raw.slice(0, 400)}`,
      response.status,
      attempt,
    );
  }

  let parsed: ChatResponse;
  try {
    parsed = JSON.parse(raw) as ChatResponse;
  } catch {
    throw new ProviderError(
      `Reply was not JSON: ${raw.slice(0, 200)}`,
      undefined,
      attempt,
    );
  }

  // A 200 carrying an error object. Gateways in front of a provider do this, and
  // treating it as a successful empty answer would end the walk on the first one.
  if (parsed.error?.message !== undefined) {
    throw new ProviderError(parsed.error.message, undefined, attempt);
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  if (text.trim() === '') {
    throw new ProviderError('Reply had no content.', undefined, attempt);
  }

  // Worth a line of its own: a truncated JSON reply fails to parse further up
  // with a syntax error that says nothing about the cause being the token cap.
  if (parsed.choices?.[0]?.finish_reason === 'length') {
    log.warn(
      `${describe(attempt)} hit the output cap; the reply is truncated.`,
    );
  }

  return text;
};

/**
 * Asks each attempt in turn and returns the first answer.
 *
 * Every failure moves to the next attempt - including a 400, which is usually
 * "this provider has never heard of that model" and not a malformed request.
 * Spending the remaining free tiers on a request that was wrong to begin with
 * costs nothing anyone is paying for; failing the review because route four had
 * a typo in its model name costs the review.
 *
 * The first error is what gets reported if the whole list is exhausted, because
 * it is the one about the model you actually chose.
 */
export const ask = async (
  attempts: readonly Attempt[],
  options: AskOptions,
): Promise<Answer> => {
  if (attempts.length === 0) {
    throw new Error(
      'No usable routes. Check the `routes` input and that a matching ' +
        '<PROVIDER>_API_KEY is set in the workflow env.',
    );
  }

  let first: Error | undefined;

  for (const attempt of attempts) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const text = await callOnce(attempt, options);
        log.info(`Answered by ${describe(attempt)}.`);
        return { text, attempt };
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        const status =
          failure instanceof ProviderError ? failure.status : undefined;
        first ??= failure;

        if (isTransient(status) && tries === 0) {
          log.debug(`${describe(attempt)} faulted, retrying once.`, failure);
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }

        const why = isQuota(status, failure.message)
          ? 'out of quota'
          : isAuth(status)
            ? 'key rejected'
            : `failed (${status ?? 'no status'})`;
        log.info(`${describe(attempt)} ${why}; deranking.`);
        log.debug('Reason', failure);
        break;
      }
    }
  }

  throw new Error(
    `All ${attempts.length} route(s) failed. First failure: ${first?.message ?? 'unknown'}`,
  );
};
