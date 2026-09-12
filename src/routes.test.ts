import { describe, expect, test } from 'bun:test';
import {
  baseUrlFor,
  envPrefix,
  keysFor,
  planAttempts,
  splitRoute,
} from './routes.ts';

describe('splitRoute', () => {
  test('splits on the first slash only, so model ids keep theirs', () => {
    expect(splitRoute('openrouter/deepseek/deepseek-r1:free')).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-r1:free',
    });
  });

  test('lower-cases the provider but leaves the model alone', () => {
    expect(splitRoute('OpenRouter/Qwen/Qwen3-Coder')).toEqual({
      provider: 'openrouter',
      model: 'Qwen/Qwen3-Coder',
    });
  });

  test('rejects a line with no model or no provider', () => {
    expect(splitRoute('groq')).toBeUndefined();
    expect(splitRoute('/model')).toBeUndefined();
    expect(splitRoute('groq/')).toBeUndefined();
  });
});

describe('envPrefix', () => {
  test('upper-cases and replaces every run of non-alphanumerics', () => {
    expect(envPrefix('openrouter')).toBe('OPENROUTER');
    expect(envPrefix('my-self.hosted')).toBe('MY_SELF_HOSTED');
  });
});

describe('keysFor', () => {
  test('reads the plain key, the numbered ones, and the bulk list', () => {
    expect(
      keysFor('groq', {
        GROQ_API_KEY: 'a',
        GROQ_API_KEY_1: 'b',
        GROQ_API_KEY_2: 'c',
        GROQ_API_KEYS: 'd, e',
      }),
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('orders numbered keys numerically rather than as strings', () => {
    expect(
      keysFor('x', {
        X_API_KEY_10: 'ten',
        X_API_KEY_2: 'two',
        X_API_KEY_1: 'one',
      }),
    ).toEqual(['one', 'two', 'ten']);
  });

  test('deduplicates, so setting both spellings means the union', () => {
    expect(keysFor('x', { X_API_KEY: 'a', X_API_KEYS: 'a,b' })).toEqual([
      'a',
      'b',
    ]);
  });

  test('ignores blanks and whitespace-only entries', () => {
    expect(keysFor('x', { X_API_KEY: '  ', X_API_KEYS: 'a,, ,b' })).toEqual([
      'a',
      'b',
    ]);
  });

  test('does not confuse another provider prefixed with the same letters', () => {
    expect(keysFor('open', { OPENROUTER_API_KEY: 'nope' })).toEqual([]);
  });
});

describe('baseUrlFor', () => {
  test('knows the built-in providers', () => {
    expect(baseUrlFor('groq', {})).toBe('https://api.groq.com/openai/v1');
  });

  test('an override wins over the built-in and loses its trailing slash', () => {
    expect(
      baseUrlFor('groq', { GROQ_BASE_URL: 'https://proxy.test/v1/' }),
    ).toBe('https://proxy.test/v1');
  });

  test('an unknown provider works when it brings its own base url', () => {
    expect(
      baseUrlFor('vllm', { VLLM_BASE_URL: 'http://10.0.0.2:8000/v1' }),
    ).toBe('http://10.0.0.2:8000/v1');
    expect(baseUrlFor('vllm', {})).toBeUndefined();
  });
});

describe('planAttempts', () => {
  test('is route-major and key-minor: every key of a model before the next model', () => {
    const attempts = planAttempts('openrouter/big\ngroq/small', {
      OPENROUTER_API_KEYS: 'k1,k2',
      GROQ_API_KEY: 'g1',
    });

    expect(attempts.map((a) => `${a.model}:${a.apiKey}`)).toEqual([
      'big:k1',
      'big:k2',
      'small:g1',
    ]);
  });

  test('reports how many keys a provider has, for the log line', () => {
    const [first] = planAttempts('openrouter/big', {
      OPENROUTER_API_KEYS: 'k1,k2',
    });
    expect(first?.keyIndex).toBe(1);
    expect(first?.keyCount).toBe(2);
  });

  test('skips a route with no key instead of failing the run', () => {
    const attempts = planAttempts('openrouter/big\ngroq/small', {
      GROQ_API_KEY: 'g',
    });
    expect(attempts.map((a) => a.provider)).toEqual(['groq']);
  });

  test('skips an unknown provider that brought no base url', () => {
    expect(planAttempts('nope/model', { NOPE_API_KEY: 'k' })).toEqual([]);
  });

  test('accepts commas as well as newlines, and ignores comments and blanks', () => {
    const attempts = planAttempts('# a comment\n\ngroq/one, groq/two\n', {
      GROQ_API_KEY: 'g',
    });
    expect(attempts.map((a) => a.model)).toEqual(['one', 'two']);
  });

  test('is empty rather than throwing when nothing is configured', () => {
    expect(planAttempts('', {})).toEqual([]);
  });
});
