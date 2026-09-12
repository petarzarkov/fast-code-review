/**
 * The action's inputs, read the way the runner supplies them.
 *
 * A composite action passes `with:` entries through as `INPUT_<NAME>`, upper
 * cased with spaces turned into underscores - the same convention a JavaScript
 * action's `@actions/core` reads, which is why this needs no dependency to do it.
 */
import { planAttempts, type Attempt } from './routes.ts';

export interface Config {
  readonly token: string;
  readonly attempts: readonly Attempt[];
  readonly exclude: readonly string[];
  readonly skipDrafts: boolean;
  readonly maxComments: number;
  readonly batchTokens: number;
  readonly language: string | undefined;
  readonly instructions: string | undefined;
  readonly approve: boolean;
  readonly replies: boolean;
  /** What counts as being addressed. Defaults to the bot's own `@login`. */
  readonly triggerPhrase: string | undefined;
}

export const input = (name: string): string =>
  (
    process.env[`INPUT_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] ?? ''
  ).trim();

const flag = (name: string, fallback: boolean): boolean => {
  const value = input(name).toLowerCase();
  if (value === '') return fallback;
  return value === 'true' || value === 'yes' || value === '1';
};

const number = (name: string, fallback: number): number => {
  const parsed = Number(input(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const optional = (name: string): string | undefined => {
  const value = input(name);
  return value === '' ? undefined : value;
};

export const DEFAULT_EXCLUDE = [
  '*.md',
  '*.lock',
  '*.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'dist/**',
  'build/**',
  'vendor/**',
  '**/__snapshots__/**',
  '*.snap',
  '*.min.js',
  '*.map',
  '*.svg',
  '*.png',
  '*.jpg',
  '*.ico',
].join(',');

export const loadConfig = (): Config => {
  /**
   * The token is taken from the input first and the ambient `GITHUB_TOKEN`
   * second. A composite action runs in the caller's process, so the caller's
   * `GITHUB_TOKEN` is already in the environment - which is convenient, and also
   * means a workflow that meant to review as a bot account and forgot to pass
   * `github_token` would silently review as `github-actions[bot]` instead. The
   * input winning makes the explicit choice the one that takes effect.
   */
  const token = input('github_token') || (process.env['GITHUB_TOKEN'] ?? '');
  if (token === '') {
    throw new Error(
      'No GitHub token. Pass `github_token:` or set GITHUB_TOKEN in env.',
    );
  }

  return {
    token,
    attempts: planAttempts(input('routes')),
    exclude: (input('exclude') || DEFAULT_EXCLUDE)
      .split(',')
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern !== ''),
    skipDrafts: flag('skip_draft_prs', true),
    /**
     * A cap on inline comments, because the failure mode of a cheap model on a
     * large diff is forty comments rather than four, and forty comments is a
     * pull request nobody reads. The overflow is counted in the body.
     */
    maxComments: number('max_comments', 20),
    batchTokens: number('batch_tokens', 60_000),
    language: optional('language'),
    instructions: optional('instructions'),
    approve: flag('approve', true),
    replies: flag('reply_to_threads', true),
    triggerPhrase: optional('trigger_phrase'),
  };
};
