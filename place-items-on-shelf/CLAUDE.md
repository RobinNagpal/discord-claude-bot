# Place-Items-On-Shelf Agent — In-Worktree Instructions

You are Claude Code running **inside a git worktree** that the Discord bot already created and `cd`'d into for you. Your job is to do the actual coding work for the task you've been given.

> Discord routing, thread creation, worktree creation/cleanup, and session continuity (`claude -c`) are **already handled by the bot**. You do not need to manage any of that. See `README.md` in this folder for the full orchestration details.

## What the bot already did before invoking you (summary)

Depending on which path you were spawned through:

**If this is a new task (Step 2 of a new-task flow):**
1. The bot received a `!claude <task>` message in the place-items-on-shelf Discord channel.
2. It ran a Step 1 Claude process in the main repo clone (`place-items-on-shelf/place-items-on-shelf/`) that: verified `main`, pulled, and ran `git worktree add worktrees/<branch> -b <branch> main` to create *your* worktree. Existing worktrees are left alone — cleanup only happens on explicit maintenance requests.
3. It parsed Step 1's output, created a Discord thread named after `<branch>`, and posted a kickoff message there.
4. It then spawned **you** (`claude -p`) with `cwd` set to your worktree. The user-facing channel exchange is logged to `discord-message-exchange.md`; the thread (where your reply will go) is logged to `discord-thread-logs/<branch>.md`.

**If this is a follow-up message in an existing thread:**
1. The user posted in a thread under the place-items-on-shelf channel.
2. The bot mapped `thread.name` -> `worktrees/<thread.name>`, verified the worktree exists, and spawned **you** with `claude -c -p` in that cwd. The `-c` flag means your prior session in this worktree is automatically resumed — you already have full context from earlier messages.

**If this is a maintenance request** (keywords like `cleanup`, `prune`, `delete worktree`, `status`, `list`, `delete pr`, `close pr`): you were spawned in the main repo clone with no thread and no new worktree. Just do the maintenance and write the summary.

### What you must do
- Write your final summary to `/tmp/claude-code-result-place-items-on-shelf.md` — the bot reads that file and posts it back to Discord.
- The bot deletes that file before every invocation, so don't rely on prior contents.
- Stdout is captured but not relayed; the result file is the canonical reply channel.

## Project Details
- **Project:** place-items-on-shelf (https://github.com/RobinNagpal/place-items-on-shelf)
- **Main repo clone (READ-ONLY, stays on `main`):** `/home/ubuntu/discord-claude-bot/place-items-on-shelf/place-items-on-shelf`
- **Worktree base:** `/home/ubuntu/discord-claude-bot/place-items-on-shelf/worktrees/`
- **Convention:** worktree folder name = branch name

The repo is new and largely empty at the time of this writing. Read `README.md` (and `CLAUDE.md` once it exists) at the repo root for the latest project context, build commands, and conventions. If tooling isn't set up yet, ask before scaffolding it.

## Rules (when working in a worktree)
1. **Safety check first:** `pwd` must contain `/worktrees/`, and `git branch --show-current` must NOT be `main` or `master`.
2. Stay on the current branch — do NOT switch branches.
3. Do NOT run git commands in the main repo clone (`place-items-on-shelf/place-items-on-shelf/`).
4. Never commit on `main`.

## When finished with a coding task
1. Run whatever quality checks the repo defines (e.g. `npm run typecheck && npm run lint && npm run prettier`, `yarn lint && yarn build`, etc.). If no scripts exist yet, skip this step and note it in your summary.
2. Commit all changes
3. Push: `git push -u origin <branch>`
4. Determine the current PR for this branch:
   - Check for an **open** PR: `gh pr list --head <branch> --state open --json number,url`
   - If an open PR exists, your push already updated it — use that URL.
   - If none exists, create a new one: `gh pr create --base main --head <branch> --title "..." --body "..."` and use the returned URL.
   - **Do NOT reuse a merged or closed PR URL.** Old merged PRs from earlier rounds of work on this same branch are stale.
5. Write summary to `/tmp/claude-code-result-place-items-on-shelf.md`. The `PR:` line MUST point to the current open PR (the one you just pushed to or created), never a previously merged one.

If the task is ambiguous, do NOT invent requirements — ask for clarification instead of committing code.

## Long-lived branches and multiple PRs

Threads and worktrees often live longer than a single PR. The user may keep working in the same thread / same worktree / same branch across many tasks, **merging PRs along the way**. After a merge, GitHub closes that PR but the branch and worktree remain. Expect this flow:

1. Round 1: you push commits -> open PR #1 -> user merges -> PR #1 closes.
2. Round 2 (same thread, same branch, `claude -c` resumes): branch still exists locally, worktree is intact, but PR #1 is gone. You must create PR #2 for the new commits.
3. Round 3: same again — PR #3, etc.

Rules for this scenario:
- Always check for an **open** PR before assuming one exists. `gh pr list --head <branch> --state open` is the source of truth — never trust the URL from a previous reply in this thread.
- If `git status` shows the branch is ahead of `origin/main` with no open PR, **create a new PR** — don't skip this step thinking one already exists.
- If the branch was force-reset or rebased onto a fresh main after a merge, that's fine; just push and open a new PR as normal.
- The `Files:` line in your summary should reflect what changed in **this round only** (since the previous merge), not the cumulative diff against main.
