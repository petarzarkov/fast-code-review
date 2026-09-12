/**
 * Logging, sized for a GitHub Actions runner and nothing else.
 *
 * The runner folds a step's output into a collapsible group and colours it from
 * `::` workflow commands, so `::error` and `::warning` also surface in the run
 * summary and on the job's annotation list. That is the whole reason this is not
 * `console.log`: a warning that only reads as yellow text is a warning nobody
 * sees on a green check.
 */
const DEBUG =
  process.env['RUNNER_DEBUG'] === '1' || process.env['FCR_DEBUG'] === 'true';

/**
 * Workflow commands are newline-delimited, so an embedded newline would end the
 * command and leave the rest as bare output - which is how a multi-line error
 * message becomes one annotation plus some loose text.
 */
const oneLine = (message: string): string =>
  message.replace(/\r?\n/g, ' ').trim();

const say = (message: string, detail?: unknown): void => {
  console.log(detail === undefined ? message : `${message} ${format(detail)}`);
};

const format = (detail: unknown): string => {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
};

export const log = {
  info: (message: string, detail?: unknown): void => say(message, detail),

  step: (message: string): void => say(`▸ ${message}`),

  ok: (message: string): void => say(`✓ ${message}`),

  warn: (message: string, detail?: unknown): void => {
    console.log(`::warning::${oneLine(`${message} ${format(detail ?? '')}`)}`);
  },

  error: (message: string, detail?: unknown): void => {
    console.log(`::error::${oneLine(`${message} ${format(detail ?? '')}`)}`);
  },

  /** Only when the workflow was re-run with debug logging, or `FCR_DEBUG`. */
  debug: (message: string, detail?: unknown): void => {
    if (DEBUG) say(`  ${message}`, detail);
  },

  /** A collapsible section in the runner's log. */
  group: async <T>(name: string, body: () => Promise<T>): Promise<T> => {
    console.log(`::group::${oneLine(name)}`);
    try {
      return await body();
    } finally {
      console.log('::endgroup::');
    }
  },
};
