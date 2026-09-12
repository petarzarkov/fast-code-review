/**
 * What a model is asked to return, and what is done with the half of it that
 * comes back malformed.
 *
 * `json_object` mode promises valid JSON and says nothing about its shape, so
 * every field here is treated as absent until proven otherwise. The parse is
 * deliberately forgiving about **wrapping** and strict about **content**: a
 * model that answers with a bare array, or wraps the array in `findings`, or
 * fences the whole thing in markdown, has said the same thing three ways and all
 * three are worth accepting. One that returns a finding with no file or no
 * summary has not, and that entry is dropped rather than posted as an empty
 * comment.
 */

export const SEVERITIES = Object.freeze(['blocker', 'concern', 'nit'] as const);
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  readonly file: string;
  readonly line: number | undefined;
  readonly severity: Severity;
  readonly category: string | undefined;
  /** One line, for the collapsed list in the review body. */
  readonly shortSummary: string;
  /** The comment itself. */
  readonly summary: string;
  /** Concrete inputs to wrong behaviour. Absent for non-correctness findings. */
  readonly failureScenario: string | undefined;
  /** Replacement for the cited lines, rendered as a GitHub suggestion block. */
  readonly suggestion: string | undefined;
}

export interface Verdict {
  readonly findings: readonly Finding[];
  /** What the model said about the change as a whole, if it said anything. */
  readonly approve: boolean | undefined;
  readonly summary: string | undefined;
}

/** The schema shown to the model. Kept next to the parser that has to honour it. */
export const RESPONSE_SCHEMA = `{
  "verdict": "approve" | "comment",
  "summary": "one sentence on the change as a whole",
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "blocker" | "concern" | "nit",
      "category": "correctness" | "security" | "performance" | "simplification" | "test-coverage",
      "short_summary": "at most 60 characters, the claim alone",
      "summary": "one or two sentences stating the defect",
      "failure_scenario": "concrete inputs or state, then the wrong result",
      "suggestion": "replacement source for that line, or omit"
    }
  ]
}`;

const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

/** The JSON inside a markdown fence, or the text unchanged. */
const unfence = (text: string): string => {
  const trimmed = text.trim();
  return FENCE.exec(trimmed)?.[1]?.trim() ?? trimmed;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * A line number from a model, which arrives as a number, as `"42"`, or as
 * `"42-49"` when it means a range. The first number of a range is the one a
 * comment anchors to.
 */
const asLine = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  const first = /\d+/.exec(typeof value === 'string' ? value : '')?.[0];
  const parsed = first === undefined ? Number.NaN : Number(first);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const asSeverity = (value: unknown): Severity => {
  const text = asString(value)?.toLowerCase() ?? '';
  return SEVERITIES.find((severity) => severity === text) ?? 'concern';
};

/**
 * A single entry, or `undefined` if it says nothing that can be posted.
 *
 * `file` and `summary` are the two that cannot be reconstructed: a finding with
 * no file has nowhere to go, and one with no summary is an empty comment. Both
 * are seen in practice from smaller models filling the array to look thorough.
 */
const toFinding = (entry: unknown): Finding | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as Record<string, unknown>;

  const file = asString(record['file'] ?? record['path']);
  const summary = asString(record['summary'] ?? record['comment']);
  if (file === undefined || summary === undefined) return undefined;

  const short =
    asString(record['short_summary']) ??
    summary.split(/(?<=[.!?])\s/)[0] ??
    summary;

  return {
    file,
    line: asLine(record['line'] ?? record['line_number']),
    severity: asSeverity(record['severity']),
    category: asString(record['category']),
    shortSummary: short.length > 120 ? `${short.slice(0, 117)}...` : short,
    summary,
    failureScenario: asString(record['failure_scenario']),
    suggestion: asString(record['suggestion']),
  };
};

/**
 * The array itself, wherever the model chose to put it.
 *
 * `undefined` means "no array was found", which is a different outcome from an
 * empty array: the first is a model that wrote prose instead of answering, and
 * the second is a model that reviewed the code and found nothing. Approving on
 * the first would approve on a refusal.
 */
const findArray = (value: unknown): readonly unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['findings', 'reviews', 'comments', 'issues']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return undefined;
};

const asApprove = (value: unknown): boolean | undefined => {
  const text = asString(value)?.toLowerCase();
  if (text === undefined) return undefined;
  if (text === 'approve' || text === 'approved') return true;
  if (text === 'comment' || text === 'request_changes') return false;
  return undefined;
};

export const parseVerdict = (raw: string): Verdict => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(raw));
  } catch {
    return { findings: [], approve: undefined, summary: undefined };
  }

  const array = findArray(parsed);
  const record = (
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {}
  ) as Record<string, unknown>;

  return {
    // `undefined` propagates: no array found is not the same as none reported.
    findings:
      array === undefined
        ? []
        : array
            .map(toFinding)
            .filter((finding): finding is Finding => finding !== undefined),
    approve:
      array !== undefined && array.length === 0
        ? (asApprove(record['verdict']) ?? true)
        : asApprove(record['verdict']),
    summary: asString(record['summary']),
  };
};

/** Whether the reply was a usable answer at all, as opposed to prose or a refusal. */
export const isStructured = (raw: string): boolean => {
  try {
    return findArray(JSON.parse(unfence(raw))) !== undefined;
  } catch {
    return false;
  }
};
