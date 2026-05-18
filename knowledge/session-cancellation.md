# Cancelling In-Flight Claude Sessions

How users abort a Claude subprocess that the bot already kicked off — typically
because they sent the prompt in the wrong channel or realised the request was
wrong mid-flight.

## User-facing surface

Two equivalent triggers, both scoped to the **current channel or thread**:

- `!cancel` as a regular Discord message.
- `/cancel` slash command.

Both kill every active Claude subprocess registered under the channel/thread
where the command was invoked, and reply with a summary listing what was
killed (description + elapsed seconds + truncated prompt preview). If nothing
is running there, the reply is "No active Claude session in this channel/thread
to cancel."

`!cancel` is checked **before** the regular `!claude` prefix gate in
`src/bot.ts`, so it works even when no other message-handling rules would
match. The same `ALLOWED_USERS` / `ALLOWED_CHANNELS` gates apply.

## How the registry works

`src/claude-sessions.ts` owns an in-process `Map<sessionKey, Set<ActiveClaudeSession>>`.
Each entry holds the `ChildProcess`, the originating Discord user id, a short
human description (e.g. `discord-bot router`), a prompt preview, and a
`cancelled` flag.

`runClaude()` in `src/claude.ts` registers a session **after** `execFile`
returns the `ChildProcess` and **unregisters** in the same callback that
resolves/rejects the outer promise — so the registry never lingers past the
subprocess's lifetime. Callers opt in by passing `sessionKey` + `sessionMeta`;
the registry no-ops when they're omitted (used by jobs and tests).

## Cancellation flow

1. User runs `!cancel` or `/cancel`.
2. `cancelSessionsAndReport(sessionKey)` looks up every session for that key,
   sets `cancelled = true` on each, sends `SIGTERM` to the child, and schedules
   a `SIGKILL` fallback 2 seconds later.
3. The `execFile` callback fires (because the child died). It sees
   `registered.cancelled === true` and rejects the `runClaude` promise with
   `ClaudeCancelledError` instead of the generic process-error path.
4. The handler that awaited `runClaude` catches the error and replies via
   `formatClaudeError`, which renders `ClaudeCancelledError` as
   "Claude session was cancelled by the user." — there's a small redundancy
   with the cancel command's own reply, but it makes the cancellation visible
   on the path the original prompt was traveling.
5. The handler's `finally` block decrements `activeJobs`, freeing up the
   concurrency slot.

## What gets a session key

| Spawn site | sessionKey | Rationale |
| --- | --- | --- |
| `handleGeneral` / `handleGmail` / `handleOutreachData` | `message.channelId` | Single per-channel request; cancel from the same channel. |
| `*Thread` handlers (insights-ui, scraping-lambdas, discord-bot follow-ups) | `thread.id` | The follow-up is conceptually "the thread's session". |
| Worktree router + maintenance + Step 1 worktree management | parent `message.channelId` | These run before any thread exists; users cancel from the channel. |
| New-task Step 2 (initial task in the freshly created worktree) | `thread.id` of the new thread | By the time Step 2 runs the thread exists and that's where the user will be looking. |
| `/compact` slash command | `channel.id` (the worktree thread) | Same thread the command was invoked in. |

`Message.channelId` is the immediate channel, which for messages posted in a
thread is the **thread's** id — so passing `message.channelId` Just Works for
both top-level channels and thread posts.

## Why kill instead of cooperative abort

The Claude CLI has no documented "abort" signal short of terminating the
process. `execFile` with a timeout already kills the child to enforce the
configured deadline, so reusing the same termination path keeps the failure
model consistent: any external death of the subprocess (timeout, cancel,
manual `kill`) flows through the same callback, and only the registry's
`cancelled` flag distinguishes "user wanted this dead" from "something else
went wrong".

`SIGTERM` then `SIGKILL` (after 2s) is the conventional polite-then-forceful
shutdown pattern — gives Claude a chance to flush logs but doesn't let a
hung subprocess linger.

## Gotchas

- **Jobs (`src/jobs/`) do not register sessions.** They're not user-triggered
  and there's no channel/thread context to cancel them from. If we ever want
  cancellable jobs, the registry can accept a job-id key, but for now they're
  out of scope.
- **The registry is in-process only.** A bot restart loses all session
  tracking. The Claude subprocesses are spawned via `execFile`, not
  `detached`, so the restart's `SIGTERM` cascade will tear them down anyway —
  the registry being empty on boot matches reality.
- **`cancelled` is checked in the same execFile callback that runs on normal
  completion.** If a session naturally finishes microseconds before the
  cancel arrives, the cancel might find an empty set and report "nothing to
  cancel" — by design.
- **No cross-channel cancel.** A `!cancel` in channel A cannot reach a
  session in channel B. We could expose an admin-only `/cancel-all`, but
  YAGNI — the common case is "I posted in the wrong channel".
