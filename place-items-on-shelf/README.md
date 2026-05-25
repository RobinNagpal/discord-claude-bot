# Place-Items-On-Shelf Workspace

This directory hosts the Discord bot's integration with the [`place-items-on-shelf`](https://github.com/RobinNagpal/place-items-on-shelf) project. The bot orchestrates git worktrees and Discord threads so each task gets its own isolated branch + conversation, and Claude Code is invoked at the right moment with the right working directory.

Structure mirrors the `insights-ui/` workspace — see `insights-ui/README.md` for the canonical write-up of how the orchestration works. The place-items-on-shelf integration is functionally identical; only the constants (repo path, worktree base, result-file paths, channel ID) differ.

## Layout
- `place-items-on-shelf/` — main repo clone (READ-ONLY, stays on `main`)
- `worktrees/<branch-name>/` — one git worktree per task/branch
- `discord-message-exchange.md` — channel-level message log
- `discord-thread-logs/<branch-name>.md` — one log per thread/worktree
- `CLAUDE.md` — instructions consumed by the in-worktree Claude Code agent
- `README.md` — this file

## Handler
Implementation: `src/handlers/place-items-on-shelf.ts` in the bot repo, dispatched from `src/bot.ts` based on `message.channelId` and `channel.parentId`. The handler is a thin wrapper around the shared `handleWorktreeChannelMessage()` / thread-follow-up plumbing in `src/handlers/worktree-channel.ts`, identical to the `insights-ui` / `scraping-lambdas` / `discord-bot` handlers.

## Result files (IPC between bot and Claude)
- `/tmp/claude-code-worktree-place-items-on-shelf.md` — written by Step 1 (worktree management)
- `/tmp/claude-code-result-place-items-on-shelf.md` — written by Step 2 / maintenance / follow-ups
- `/tmp/claude-code-route-place-items-on-shelf.json` — written by the LLM router
All three are deleted before every invocation.

## Environment Variables
Set in `.env` in the bot repo root:
- `PLACE_ITEMS_ON_SHELF_CHANNEL` — Discord channel ID that triggers this workflow (`1508534205871816804`)
- `PLACE_ITEMS_ON_SHELF_MAIN_REPO` — main repo path (`/home/ubuntu/discord-claude-bot/place-items-on-shelf/place-items-on-shelf`)
- `PLACE_ITEMS_ON_SHELF_WORKTREE_BASE` — worktree base dir (`/home/ubuntu/discord-claude-bot/place-items-on-shelf/worktrees`)

## Quality checks
The repo is new and may not yet define lint/build scripts. The in-worktree agent runs whatever the repo defines at the time of the task (e.g. `npm run typecheck && npm run lint && npm run prettier` for a TypeScript setup, `yarn compile && yarn prettier-check` for a yarn monorepo, etc.). If no scripts exist yet, the agent skips quality checks and notes it in the summary.
