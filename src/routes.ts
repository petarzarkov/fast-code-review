/**
 * Turns the `routes` input plus whatever keys are in the environment into an
 * ordered list of attempts.
 *
 * A **route** is one line of the input - a provider and a model. An **attempt**
 * is that route paired with one API key. One route with three OpenRouter keys is
 * three attempts, and that multiplication is the point of this file: a single
 * free tier is a few requests a day, and a review that stops at the first 429 is
 * a review that runs once and then never again until the quota resets.
 *
 * The order is route-major, key-minor: every key for the best model is spent
 * before dropping to the next model. Deranking is a last resort, not a load
 * balancer - the first route is the one you actually want reviewing your code.
 */
import { log } from './log.ts';

/**
 * OpenAI-compatible API roots, so `provider/model` is all a workflow has to say.
 *
 * Not an exhaustive list and not meant to be: an unknown provider is resolved
 * from `<PROVIDER>_BASE_URL` instead, which is what makes "anything
 * OpenAI-compatible" true rather than "anything on this list".
 */
export const PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  xai: 'https://api.x.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  ollama: 'http://localhost:11434/v1',
});

export interface Attempt {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Which key of that provider this is, 1-based. For logs: the key itself must
   * never reach the runner's output, and "openrouter key 2 of 3" is the whole
   * of what a reader needs to know about which one failed.
   */
  readonly keyIndex: number;
  readonly keyCount: number;
}

/** `openrouter key 2/3 · deepseek/deepseek-r1:free`, for logs and errors. */
export const describe = (attempt: Attempt): string =>
  `${attempt.provider} key ${attempt.keyIndex}/${attempt.keyCount} · ${attempt.model}`;

/**
 * `openrouter` becomes `OPENROUTER`, `my-host` becomes `MY_HOST`.
 *
 * Anything not alphanumeric becomes `_`, because that is the only shape a shell
 * and a `env:` block will both accept, and a provider alias is written by hand.
 */
export const envPrefix = (provider: string): string =>
  provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * Other names a provider's key is commonly stored under.
 *
 * `google` and `gemini` are one provider with two names, and which one a
 * repository already has a secret for is not something a route should have to
 * know. Google's own documentation says `GEMINI_API_KEY`, so that is the name
 * most existing secrets carry, while the route reads better as `google/...`.
 * Without this, a `google/gemini-2.5-flash` route next to a `GEMINI_API_KEY`
 * secret is silently skipped for having no key - which is a misconfiguration
 * that looks exactly like a working setup until you read the log.
 */
const KEY_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  GOOGLE: ['GEMINI'],
  GEMINI: ['GOOGLE'],
});

/** The keys stored under one exact prefix, in the order the three spellings give. */
const keysUnder = (
  prefix: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly (string | undefined)[] => {
  const numbered = Object.keys(env)
    .map((name) => new RegExp(`^${prefix}_API_KEY_(\\d+)$`).exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => env[match[0]]);

  return [
    env[`${prefix}_API_KEY`],
    ...numbered,
    ...(env[`${prefix}_API_KEYS`] ?? '').split(/[\n,]/),
  ];
};

/**
 * Every key configured for a provider, best first.
 *
 * Three spellings, because adding twelve secrets to a repository by hand is the
 * thing most likely to stop someone doing it:
 *   `X_API_KEY`            one key, the ordinary case
 *   `X_API_KEY_1`, `_2`    several keys, one secret each
 *   `X_API_KEYS`           several keys in one secret, comma or newline separated
 *
 * All three are read and concatenated in that order, then the provider's alias
 * prefixes after them, and the whole lot deduplicated - a workflow that sets
 * both `GROQ_API_KEY` and `GROQ_API_KEYS` means the union and not an error. The
 * provider's own prefix comes first so an explicit `GOOGLE_API_KEY` outranks a
 * `GEMINI_API_KEY` that may be left over from something else.
 */
export const keysFor = (
  provider: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => {
  const prefix = envPrefix(provider);
  const prefixes = [prefix, ...(KEY_ALIASES[prefix] ?? [])];

  return [
    ...new Set(
      prefixes
        .flatMap((each) => keysUnder(each, env))
        .map((key) => key?.trim() ?? '')
        .filter((key) => key !== ''),
    ),
  ];
};

/**
 * The API root for a provider: the built-in one, or `<PROVIDER>_BASE_URL`.
 *
 * The override wins over the built-in so a proxy, a gateway or a self-hosted
 * endpoint can stand in for a named provider without renaming every route.
 */
export const baseUrlFor = (
  provider: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const override = env[`${envPrefix(provider)}_BASE_URL`]?.trim();
  if (override !== undefined && override !== '') {
    return override.replace(/\/+$/, '');
  }
  return PROVIDERS[provider];
};

/**
 * `provider/model` on the **first** slash only.
 *
 * Model identifiers contain slashes of their own - `deepseek/deepseek-r1:free`
 * is one model, not a provider and a model - so splitting on every slash would
 * make every OpenRouter route unroutable.
 */
export const splitRoute = (
  line: string,
): { readonly provider: string; readonly model: string } | undefined => {
  const at = line.indexOf('/');
  if (at <= 0 || at === line.length - 1) return undefined;
  return {
    provider: line.slice(0, at).trim().toLowerCase(),
    model: line.slice(at + 1).trim(),
  };
};

/**
 * The attempt list, in the order it should be tried.
 *
 * A route with no key and a route with no base URL are both **skipped with a
 * warning** rather than throwing. A repository that lists six providers and holds
 * secrets for two is the normal case, not a misconfiguration: the same workflow
 * file gets copied between repositories, and the one that has a Groq key should
 * not fail because it has no Cerebras key.
 */
export const planAttempts = (
  routes: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly Attempt[] => {
  const attempts: Attempt[] = [];
  const lines = routes
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  for (const line of lines) {
    const split = splitRoute(line);
    if (split === undefined) {
      log.warn(`Ignoring route "${line}": expected <provider>/<model>.`);
      continue;
    }

    const { provider, model } = split;
    const baseUrl = baseUrlFor(provider, env);
    if (baseUrl === undefined) {
      log.warn(
        `Ignoring route "${line}": ${provider} is not a known provider and ` +
          `${envPrefix(provider)}_BASE_URL is not set.`,
      );
      continue;
    }

    const keys = keysFor(provider, env);
    if (keys.length === 0) {
      log.warn(
        `Ignoring route "${line}": no key. Set ${envPrefix(provider)}_API_KEY ` +
          `(or ${envPrefix(provider)}_API_KEYS for several) in the job env.`,
      );
      continue;
    }

    keys.forEach((apiKey, index) => {
      attempts.push({
        provider,
        model,
        baseUrl,
        apiKey,
        keyIndex: index + 1,
        keyCount: keys.length,
      });
    });
  }

  return attempts;
};
