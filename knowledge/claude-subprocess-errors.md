# Claude CLI Subprocess: stdin, Errors, and Rate Limits

How `runClaude()` in `src/claude.ts` invokes the Claude Code CLI and why the
error-handling looks the way it does.

## Invocation

`runClaude()` uses `child_process.execFile` to spawn:

```
claude -p --dangerously-skip-permissions --output-format text <prompt>
```

(prefixed with `-c` when `continueSession: true`).

## Why we close stdin immediately

`execFile` pipes stdin by default and never closes it. The Claude CLI waits
up to ~3 seconds for stdin data before proceeding, and if nothing arrives it
prints this warning to **stderr**:

```
Warning: no stdin data received in 3s, proceeding without it.
If piping from a slow command, redirect stdin explicitly: < /dev/null to
skip, or wait longer.
```

On **success** (exit 0), execFile's callback ignores stderr, so the warning
is silently dropped — but we still paid a ~3-second latency penalty on every
call.

On **failure** (rate limit or other error), the CLI writes its real error
message to **stdout** (since `--output-format text` controls stdout), leaves
the stdin warning on **stderr**, and exits non-zero. The previous version of
`runClaude` did `reject(new Error(stderr || error.message))`, which surfaced
only the stdin warning — hiding the actual "Claude Code usage limit reached"
message behind the opaque "no stdin data received" text.

The fix is `child.stdin?.end()` immediately after spawning. No warning, no
3-second delay, and errors surface cleanly.

## Rate-limit detection (`ClaudeRateLimitError`)

When the account-level usage limit is hit, the CLI exits non-zero with
phrasing like "Claude AI usage limit reached" on stdout. `runClaude` checks
the combined stdout+stderr against `RATE_LIMIT_PATTERNS` and throws a
`ClaudeRateLimitError` (with the matching lines preserved in `.detail`).
Handlers use `formatClaudeError()` in `src/discord.ts`, which special-cases
this error class and shows a user-facing "Claude Code usage limit reached.
Please try again once the limit resets." message with the reset detail from
the CLI — instead of wrapping it as "Follow-up failed: ..." or similar.

For any non-rate-limit error, `formatClaudeError` falls back to the original
`${prefix}: ${formatError(err)}` behavior, and the reject path combines
stdout + stderr (with the stdin warning stripped defensively) so the real
error surfaces.

## Why the "stdin warning once after reset" bug existed

Before the fix, every `claude -p` call emitted the stdin warning to stderr,
always. On successful calls the warning was invisible to users. When the
rate limit finally reset, the very next call (especially with `-c`
continuing a session that had just failed) could still exit non-zero once —
session resumption quirk, transient server-side caching, etc. — and the
reject path surfaced stderr, which was still the stdin warning. With stdin
closed at spawn time, the warning no longer exists, so even if that first
post-reset call fails, users see the actual error from stdout/exit code,
not the misleading stdin text.

## Summary of relevant exports

- `runClaude(prompt, options)` — src/claude.ts
- `ClaudeRateLimitError` — src/claude.ts (throws a distinct class on limit)
- `formatClaudeError(err, prefix)` — src/discord.ts (rate-limit-aware
  formatter used by every handler that catches a `runClaude` rejection)
