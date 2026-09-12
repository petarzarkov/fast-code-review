import { describe, expect, test } from 'bun:test';
import { ask, ProviderError } from './ai.ts';
import type { Attempt } from './routes.ts';

const attempt = (model: string, apiKey: string, baseUrl: string): Attempt => ({
  provider: 'fake',
  model,
  baseUrl,
  apiKey,
  keyIndex: 1,
  keyCount: 1,
});

/**
 * A stand-in provider. Each key is scripted to a status, so one `ask` can walk a
 * list and the test can assert on the order it walked.
 */
const withServer = async <T>(
  script: Readonly<Record<string, number>>,
  body: (base: string, seen: readonly string[]) => Promise<T>,
): Promise<T> => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = (request.headers.get('authorization') ?? '').replace(
        'Bearer ',
        '',
      );
      const { model } = (await request.json()) as { model: string };
      seen.push(`${model}|${key}`);

      const status = script[key] ?? 200;
      if (status === 200) {
        return Response.json({
          choices: [{ message: { content: 'answered' } }],
        });
      }
      return Response.json(
        { error: { message: `status ${status}` } },
        { status },
      );
    },
  });

  try {
    return await body(`http://localhost:${server.port}/v1`, seen);
  } finally {
    server.stop(true);
  }
};

const messages = [{ role: 'user' as const, content: 'hi' }];

describe('ask', () => {
  test('returns the first attempt that answers', async () => {
    await withServer({ good: 200 }, async (base) => {
      const answer = await ask([attempt('m', 'good', base)], { messages });
      expect(answer.text).toBe('answered');
      expect(answer.attempt.apiKey).toBe('good');
    });
  });

  test('deranks past a spent key to a later one', async () => {
    await withServer({ spent: 429, good: 200 }, async (base, seen) => {
      const answer = await ask(
        [attempt('best', 'spent', base), attempt('worse', 'good', base)],
        { messages },
      );
      expect(answer.attempt.model).toBe('worse');
      expect(seen).toEqual(['best|spent', 'worse|good']);
    });
  });

  test('deranks past a 402, which no amount of waiting fixes', async () => {
    await withServer({ unpaid: 402, good: 200 }, async (base) => {
      const answer = await ask(
        [attempt('paid-only', 'unpaid', base), attempt('free', 'good', base)],
        { messages },
      );
      expect(answer.attempt.model).toBe('free');
    });
  });

  test('deranks past a 404, which is a model id that does not exist', async () => {
    await withServer({ typo: 404, good: 200 }, async (base) => {
      const answer = await ask(
        [attempt('mispelled', 'typo', base), attempt('real', 'good', base)],
        { messages },
      );
      expect(answer.attempt.model).toBe('real');
    });
  });

  test('does not retry a rejected key, but does retry a server fault', async () => {
    await withServer({ revoked: 401, good: 200 }, async (base, seen) => {
      await ask([attempt('a', 'revoked', base), attempt('b', 'good', base)], {
        messages,
      });
      // 401 is final for that key, so it is tried exactly once.
      expect(seen.filter((entry) => entry.endsWith('revoked'))).toHaveLength(1);
    });

    await withServer({ flaky: 503, good: 200 }, async (base, seen) => {
      await ask([attempt('a', 'flaky', base), attempt('b', 'good', base)], {
        messages,
      });
      // A 5xx is the server's fault, so the same key gets one more go.
      expect(seen.filter((entry) => entry.endsWith('flaky'))).toHaveLength(2);
    });
  });

  test('reports the first failure when every route is exhausted', async () => {
    await withServer({ a: 429, b: 500 }, async (base) => {
      const promise = ask(
        [attempt('one', 'a', base), attempt('two', 'b', base)],
        { messages },
      );
      // The first failure is the one about the model you actually chose.
      await expect(promise).rejects.toThrow(/All 2 route\(s\) failed/);
    });
  });

  test('an empty list is a configuration error, not a silent success', async () => {
    await expect(ask([], { messages })).rejects.toThrow(/No usable routes/);
  });

  test('a 200 carrying an error object does not end the walk', async () => {
    // Gateways in front of a provider do this, and treating it as a successful
    // empty answer would stop on the first one.
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: 'upstream boom' } }),
    });
    try {
      const base = `http://localhost:${server.port}/v1`;
      await expect(
        ask([attempt('m', 'k', base)], { messages }),
      ).rejects.toThrow(/upstream boom/);
    } finally {
      server.stop(true);
    }
  });
});

describe('ProviderError', () => {
  test('carries the status and the attempt it came from', () => {
    const which = attempt('m', 'k', 'http://x');
    const error = new ProviderError('nope', 429, which);
    expect(error.status).toBe(429);
    expect(error.attempt).toBe(which);
  });
});
