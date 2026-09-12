/**
 * Whether a comment is addressed to this bot.
 *
 * Kept apart from the flow that acts on it, because getting this wrong is the
 * expensive failure in both directions: too eager and the bot answers every
 * conversation it can see, too strict and a person types its name and gets
 * nothing back.
 */

/**
 * A mention has to stand on its own.
 *
 * `@dunxonu` inside `@dunxonufoo` is not a mention, and neither is one inside a
 * fenced code block or a quoted reply - the second is how a bot ends up
 * answering its own name quoted back at it by the very notification that
 * quoted it.
 */
const withoutQuotedText = (body: string): string =>
  body
    // Fenced code, which is where a pasted log carrying the name lives.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    // Markdown quotes, which is what a "replying to" block is.
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');

export const mentions = (body: string, phrase: string): boolean => {
  if (phrase === '') return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A word boundary is wrong here: `@` is not a word character, so `\b@name`
  // never matches. The guard that is actually needed is on the trailing side,
  // so `@name` does not fire inside `@nameother`.
  return new RegExp(`${escaped}(?![\\w-])`, 'i').test(withoutQuotedText(body));
};

/** The default trigger: the bot's own login, at-prefixed. */
export const defaultPhrase = (login: string): string => `@${login}`;
