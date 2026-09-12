import { describe, expect, test } from 'bun:test';
import { defaultPhrase, mentions } from './mention.ts';

describe('mentions', () => {
  test('finds the phrase anywhere in the body', () => {
    expect(mentions('hey @dunxonu can you look', '@dunxonu')).toBe(true);
    expect(mentions('@dunxonu', '@dunxonu')).toBe(true);
    expect(mentions('thoughts, @dunxonu?', '@dunxonu')).toBe(true);
  });

  test('is case-insensitive, since people type names how they like', () => {
    expect(mentions('@DunxOnu what do you think', '@dunxonu')).toBe(true);
  });

  test('does not fire on a longer name that starts with the phrase', () => {
    expect(mentions('ask @dunxonubot instead', '@dunxonu')).toBe(false);
    expect(mentions('@dunxonu-staging is down', '@dunxonu')).toBe(false);
  });

  test('ignores a mention inside a fenced code block', () => {
    // A pasted run log naming the bot is not someone asking it a question.
    expect(
      mentions('look at this:\n```\nreviewer: @dunxonu\n```\n', '@dunxonu'),
    ).toBe(false);
  });

  test('ignores a mention inside inline code', () => {
    expect(mentions('the `@dunxonu` account posts these', '@dunxonu')).toBe(
      false,
    );
  });

  test('ignores a mention inside a quoted reply', () => {
    // This is the loop that matters: a notification quotes the comment that
    // named the bot, and answering the quote answers nobody.
    expect(mentions('> @dunxonu said something\n\nagreed', '@dunxonu')).toBe(
      false,
    );
  });

  test('still fires when a quote is present but the ask is outside it', () => {
    expect(
      mentions('> earlier point\n\n@dunxonu thoughts on that?', '@dunxonu'),
    ).toBe(true);
  });

  test('an empty phrase never matches, rather than matching everything', () => {
    expect(mentions('anything at all', '')).toBe(false);
  });

  test('regex metacharacters in a phrase are literal', () => {
    expect(mentions('ping @bot.dev now', '@bot.dev')).toBe(true);
    expect(mentions('ping @botxdev now', '@bot.dev')).toBe(false);
  });
});

describe('defaultPhrase', () => {
  test('is the login, at-prefixed', () => {
    expect(defaultPhrase('dunxonu')).toBe('@dunxonu');
  });
});
