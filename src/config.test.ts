import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from './config.ts';

/**
 * `loadConfig` reads `process.env` directly, the way the runner supplies inputs,
 * so these set and unset it around each case rather than passing a fake in.
 */
const KEYS = [
  'INPUT_GITHUB_TOKEN',
  'GITHUB_TOKEN',
  'INPUT_ROUTES',
  'INPUT_ANSWER_ROUTES',
  'INPUT_TRIGGER_PHRASE',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEYS',
];

const withEnv = <T>(env: Record<string, string>, body: () => T): T => {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return body();
  } finally {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
};

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('loadConfig', () => {
  test('answer routes fall back to the review routes when unset', () => {
    const config = withEnv(
      {
        GITHUB_TOKEN: 't',
        INPUT_ROUTES: 'groq/a\ngroq/b',
        GROQ_API_KEY: 'k',
      },
      loadConfig,
    );
    expect(config.attempts).toHaveLength(2);
    expect(config.answerAttempts).toBe(config.attempts);
  });

  test('answer routes are planned separately when set', () => {
    const config = withEnv(
      {
        GITHUB_TOKEN: 't',
        INPUT_ROUTES: 'groq/fast',
        INPUT_ANSWER_ROUTES: 'groq/smart\ngroq/smarter',
        GROQ_API_KEY: 'k',
      },
      loadConfig,
    );
    expect(config.attempts.map((a) => a.model)).toEqual(['fast']);
    expect(config.answerAttempts.map((a) => a.model)).toEqual([
      'smart',
      'smarter',
    ]);
  });

  test('the input token wins over the ambient one', () => {
    // A workflow that meant to post as a bot and set only the ambient token
    // would otherwise post as github-actions[bot] without saying so.
    const config = withEnv(
      { GITHUB_TOKEN: 'ambient', INPUT_GITHUB_TOKEN: 'explicit' },
      loadConfig,
    );
    expect(config.token).toBe('explicit');
  });

  test('no token at all is an error, not a silent default', () => {
    expect(() => withEnv({}, loadConfig)).toThrow(/No GitHub token/);
  });

  test('an unset trigger phrase stays undefined, so the login is used', () => {
    const config = withEnv({ GITHUB_TOKEN: 't' }, loadConfig);
    expect(config.triggerPhrase).toBeUndefined();
  });
});
