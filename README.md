# fast-code-review

AI code review on pull requests, through **any OpenAI-compatible provider**, with
deranking across keys and models so a spent free tier never stops the review.

One review per push: findings land as inline comments on the lines they are
about, the body stays a summary, and the review approves when there is nothing
to say.

```yaml
- uses: petarzarkov/fast-code-review@v1
  with:
    routes: |
      openrouter/deepseek/deepseek-chat-v3.1:free
      groq/llama-3.3-70b-versatile
      google/gemini-2.5-flash
  env:
    OPENROUTER_API_KEYS: ${{ secrets.OPENROUTER_API_KEYS }}
    GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

## Why routes

A free tier is a handful of requests a day. A reviewer that stops at the first
`429` runs once and then goes quiet until the quota resets, which is the same as
not having one.

A **route** is a provider and a model. An **attempt** is that route paired with
one API key. Three OpenRouter keys on one route is three attempts, and the list
is walked **route-major, key-minor**: every key for your best model is spent
before dropping to the next model. Deranking is a last resort, not a load
balancer — the first route is the one you actually want reviewing your code.

Anything that speaks `POST /chat/completions` is a route. Fifteen providers are
built in by name; anything else works by setting `<NAME>_BASE_URL`.

<details>
<summary>Built-in provider names</summary>

`openrouter` · `groq` · `google` (or `gemini`) · `openai` · `anthropic` ·
`deepseek` · `mistral` · `together` · `cerebras` · `xai` · `fireworks` ·
`nvidia` · `sambanova` · `ollama`

</details>

## Keys

Keys come from the job `env`, never from an input — an input would be echoed into
the workflow log on a debug re-run. Three spellings, because adding twelve
secrets by hand is the thing most likely to stop you doing it:

| Spelling | For |
| --- | --- |
| `OPENROUTER_API_KEY` | one key |
| `OPENROUTER_API_KEY_1`, `_2`, … | several keys, one secret each |
| `OPENROUTER_API_KEYS` | several keys in one secret, comma-separated |

All three are read and unioned. A route whose provider has no key is skipped with
a warning rather than failing the run: the same workflow file gets copied between
repositories, and the one that only has a Groq key should still review.

`google` and `gemini` are one provider under two names, and either spelling of
the secret works for either spelling of the route — Google's own docs say
`GEMINI_API_KEY`, while the route reads better as `google/gemini-2.5-flash`. An
explicit `GOOGLE_API_KEY` still outranks a `GEMINI_API_KEY`.

## Setup

```yaml
name: Code review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_comment:
    types: [created]

concurrency:
  group: review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

permissions: {}

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: petarzarkov/fast-code-review@v1
        with:
          routes: |
            openrouter/deepseek/deepseek-chat-v3.1:free
            openrouter/qwen/qwen3-coder:free
            groq/llama-3.3-70b-versatile
            google/gemini-2.5-flash
        env:
          OPENROUTER_API_KEYS: ${{ secrets.OPENROUTER_API_KEYS }}
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

No checkout step: the action reads the diff through the API and never touches the
working tree.

`ready_for_review` matters if you leave `skip_draft_prs` on (the default) — it is
what picks the pull request up when it stops being a draft.

### Reviewing as a bot account

Pass a personal access token and the review appears as that account rather than
as `github-actions[bot]`:

```yaml
        with:
          github_token: ${{ secrets.MY_BOT_TOKEN }}
```

One thing changes when you do. A review posted with `GITHUB_TOKEN` cannot trigger
another workflow; one posted with a PAT can, including this one. The action's own
loop guard handles the thread-reply case, but add the sender check to the job as
well so a run is not even started:

```yaml
    if: github.event.sender.login != 'my-bot-account'
```

## What it does

**Inline comments.** One review per run, comments anchored to the lines they are
about. The diff is handed to the model with each line's number printed beside it,
and the model cites those numbers back — asking a model to count rows is the
least reliable way to get a number that is already on the row. Any finding whose
line is not in the diff is summarised in the body instead, because GitHub rejects
the *entire* review if one comment names an uncommentable line.

**Approving.** The review approves only when the model returned a structured,
empty findings list *and* did not ask for a comment. Both signals have to agree:
a model that lists five findings and then says "approve" does not get one, and
neither does a reply that was prose, a refusal, or a truncation — an empty
findings list is vacuously clean, and approving on one is how a broken run
becomes a green check. Set `approve: false` in a repository where an approval
would satisfy a required-reviewer rule.

**Converging.** The first review sees the whole diff. Every review after it sees
only the files touched since this account's last one, and findings outside that
scope are counted in the body rather than posted again.

This is the part that makes a pull request finish. The model sees the full diff
on every push and is not deterministic over it, so untouched code gets a fresh
chance to yield a finding on every run — five rounds, two dozen findings, never
an approval, and each new finding equally true and equally reportable in round
one. Carried findings are stated in the body rather than dropped, because they
are real and hiding them would be the action deciding what you may see.

**Resolved threads.** Threads you resolved are read through GraphQL — REST has no
notion of a thread being resolved — and the lines they cover are never sent to a
model again. A finding that still has an *open* thread of ours on the same line
is not repeated either; matched on file and line rather than on text, because the
model rewords the same finding every run, which is why text matching never caught
it.

**Discussions.** Reply to one of its review comments and it answers in that
thread. It only answers where it already spoke — a thread between two humans is
not addressed to it — and it is told to concede: you know the codebase, it read a
diff, and an argument costs more of your attention than the finding was worth.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `routes` | three free-tier routes | `<provider>/<model>` per line, best first |
| `github_token` | ambient `GITHUB_TOKEN` | PAT to review as a bot account |
| `exclude` | lockfiles, `dist/**`, images, snapshots | comma-separated globs; no slash matches the basename |
| `skip_draft_prs` | `true` | |
| `approve` | `true` | allow submitting `APPROVE` |
| `reply_to_threads` | `true` | answer replies to its own comments |
| `max_comments` | `20` | inline cap; the rest are listed in the body, worst kept first |
| `batch_tokens` | `60000` | per-call budget; lower it for small context windows |
| `language` | model's own | e.g. `Bulgarian` |
| `instructions` | — | repository-specific rules, taking precedence over the defaults |
| `bun_version` | `1.4.1` | |

### instructions

Appended to the system prompt and overriding the built-in threshold. Use it for
the things a model cannot infer from a diff:

```yaml
          instructions: |
            This repo bans `enum` - flag any that appear.
            `packages/*/src/index.ts` is the public API; flag breaking changes there.
            Do not flag missing tests in `examples/`.
```

## What it will not report

The default threshold is deliberately high. It reports logic that produces a
wrong result, unhandled rejections on paths that will be taken, races, leaks,
injection and authorization gaps, destructive operations without a guard, API
breaks, and duplication the diff itself introduces.

It does not report style, naming, import order, missing tests or docs, defensive
checks for conditions that cannot occur, or anything phrased "consider" — a
formatter and a linter own the first set, and the rest is noise a reviewer learns
to scroll past. An empty findings array is the correct answer for most diffs.

## Development

No build step and no dependencies. The action is a composite that runs this
source with Bun; GitHub's REST and GraphQL APIs and the model calls all go
through `fetch`.

```sh
bun install
bun run ci      # format:check, lint:check, typecheck, test
```

## License

MIT
