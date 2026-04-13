# Insights-UI (KoalaGains) Workspace

This directory hosts the Discord bot's integration with the KoalaGains (`dodao-ui/insights-ui`) project. The bot orchestrates git worktrees and Discord threads so each task gets its own isolated branch + conversation, and Claude Code is invoked at the right moment with the right working directory.

## Layout
- `dodao-ui/` — main repo clone (READ-ONLY, stays on `main`)
- `worktrees/<branch-name>/` — one git worktree per task/branch
- `discord-message-exchange.md` — channel-level message log
- `discord-thread-logs/<branch-name>.md` — one log per thread/worktree
- `CLAUDE.md` — instructions consumed by the in-worktree Claude Code agent
- `README.md` — this file

## What the Bot Does

Implementation: `src/handlers/insights-ui.ts` in the bot repo, dispatched from `src/bot.ts` based on `message.channelId` and `channel.parentId`.

### 1. Message dispatch (`src/bot.ts`)
- Listens for `messageCreate`, ignores bot messages, requires the `!claude` prefix.
- Enforces `ALLOWED_CHANNELS` / `ALLOWED_USERS` allowlists and a `MAX_CONCURRENT` (default 3) cap on simultaneous Claude invocations.
- Routing:
  - Message in a thread whose `parentId === INSIGHTS_UI_CHANNEL` → `handleInsightsUIThread`
  - Message in `INSIGHTS_UI_CHANNEL` itself → `handleInsightsUI`
  - Other channels → outreach-data / gmail / general handlers

### 2. Main channel — `handleInsightsUI`
Decides between two paths via `isMaintenanceRequest()` keyword check:

**Maintenance path** (keywords: `cleanup`, `clean up`, `list worktree`, `prune`, `delete worktree`, `remove worktree`, `delete pr`, `close pr`, `status`, `list pr`):
1. `clearResultFiles()` — wipes `/tmp/claude-code-result-insights.md` and `/tmp/claude-code-worktree-insights.md` so stale state can't leak.
2. Posts a "Running maintenance task..." reply.
3. Spawns `claude -p` in `INSIGHTS_UI_MAIN_REPO` (`dodao-ui/`) with the maintenance prompt — safety check on `main`, list/remove worktrees, prune, close PRs, write summary to `/tmp/claude-code-result-insights.md`.
4. Reads the result file and posts it back (chunked to fit Discord's 2000-char limit).
5. Logs both user message and Claude reply to `discord-message-exchange.md`.
6. **No thread, no worktree created.**

**New-task path** (default — anything not matching maintenance keywords):
1. `clearResultFiles()`.
2. Posts "Starting new insights-ui task... Step 1/2: Managing worktrees..." reply.
3. **Step 1 — Worktree creation.** Spawns `claude -p` in `dodao-ui/` with `buildWorktreeManagementPrompt`:
   - Safety check: ensure main repo is on `main` (checkout/stash if not).
   - `git pull origin main`.
   - Pick a new kebab-case branch name and run `git worktree add worktrees/<branch> -b <branch> main`.
   - Existing worktrees, branches, and PRs are **left untouched** — cleanup only happens via the maintenance path (explicit user request).
   - Write a markdown report (path, branch, full `git worktree list`) to `/tmp/claude-code-worktree-insights.md`.
4. **Parse Step 1 output** with `parseWorktreeResult()` — three fallback regexes that handle plain `Path:`, markdown `**Path:** \`...\``, and a generic `/worktrees/...` grep. Extracts `worktreePath` + `branchName`.
5. **Create Discord thread** under the main channel via `channel.threads.create()`. Thread name = `sanitizeBranchForThread(branchName)` (alphanumeric/dash/underscore, max 90 chars). 24-hour auto-archive.
6. Posts a kickoff message in the thread with task / worktree path / branch.
7. Appends to `discord-thread-logs/<branch>.md` (creates the file with a header on first write) and logs the thread-creation event to `discord-message-exchange.md`.
8. **Step 2 — Initial coding.** Spawns `claude -p` with `cwd = worktreePath` and `buildInitialTaskPrompt`:
   - Safety check: `pwd` must contain `/worktrees/`, current branch must NOT be `main`.
   - Do the task. Read repo-root `CLAUDE.md` for workflow details.
   - On finish: `yarn lint && yarn prettier-check && yarn build`, commit, `git push -u origin <branch>`, `gh pr create`.
   - Write summary (files changed, branch, commit hash, PR URL) to `/tmp/claude-code-result-insights.md`.
9. Reads the result file, posts it to the thread chunked, appends it to `discord-thread-logs/<branch>.md`.

### 3. Thread messages — `handleInsightsUIThread`
1. Computes `worktreePath = ${INSIGHTS_UI_WORKTREE_BASE}/${thread.name}` and verifies it exists. If missing, replies with an error and stops.
2. `clearResultFiles()`.
3. Logs the user message to `discord-thread-logs/<thread.name>.md`.
4. Posts "Continuing session..." confirmation.
5. Spawns `claude -c -p` (the `-c` flag triggers true session continuity — Claude resumes the prior conversation in that cwd) with `buildFollowupPrompt` and `cwd = worktreePath`. Same finish-task expectations as Step 2: lint/prettier/build, commit, push, update PR, write summary to the result file.
6. Reads the result, appends to the thread log, posts it back chunked.

### 4. Subprocess invocation (`src/claude.ts`)
- All Claude calls go through `runClaude(prompt, { cwd, continueSession? })`.
- Spawns `claude -p --dangerously-skip-permissions --output-format text <prompt>` via `child_process.execFile`.
- If `continueSession: true`, prepends `-c` to the args (used only by `handleInsightsUIThread`).
- Timeout: `CLAUDE_TIMEOUT` (currently 1,200,000 ms = 20 min) — long enough for `yarn build`.
- Buffer cap: `MAX_BUFFER` (default 1 MB).

### 5. Logging
- **`insights-ui/discord-message-exchange.md`** — channel-level audit trail. Every user message and every Claude reply in the main channel gets a timestamped, role-tagged section appended via `appendChannelExchange()`.
- **`insights-ui/discord-thread-logs/<worktree-name>.md`** — one file per thread/worktree. Created on first write with a header pointing at the worktree path. Every message in the thread (user + Claude) gets appended via `appendThreadExchange()`.

### 6. Result-file plumbing
The bot uses two `/tmp` files as the IPC channel between itself and the spawned Claude processes:
- `/tmp/claude-code-worktree-insights.md` — written by Step 1, parsed for path/branch.
- `/tmp/claude-code-result-insights.md` — written by Step 2, maintenance, and follow-ups; relayed back to Discord.
Both are deleted before every invocation to prevent stale-state contamination.

## Environment Variables
Set in `.env` in the bot repo root:
- `INSIGHTS_UI_CHANNEL` — Discord channel ID that triggers this workflow (`1491102767224324309`)
- `INSIGHTS_UI_MAIN_REPO` — main repo path (`/home/ubuntu/discord-claude-bot/insights-ui/dodao-ui`)
- `INSIGHTS_UI_WORKTREE_BASE` — worktree base dir (`/home/ubuntu/discord-claude-bot/insights-ui/worktrees`)
- `INSIGHTS_UI_THREAD_LOGS_DIR` — thread log dir (`/home/ubuntu/discord-claude-bot/insights-ui/discord-thread-logs`)
- `INSIGHTS_UI_EXCHANGE_LOG` — channel log file (`/home/ubuntu/discord-claude-bot/insights-ui/discord-message-exchange.md`)
- `CLAUDE_TIMEOUT` — subprocess timeout in ms (1200000)
- `MAX_CONCURRENT` — concurrent message-handler cap (3)
