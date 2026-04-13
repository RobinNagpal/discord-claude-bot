# Scraping-Lambdas Workspace

This directory hosts the Discord bot's integration with the `scraping-lambdas` project. The bot orchestrates git worktrees and Discord threads so each task gets its own isolated branch + conversation, and Claude Code is invoked at the right moment with the right working directory.

Structure mirrors the `insights-ui/` workspace — see `insights-ui/README.md` for the canonical write-up of how the orchestration works. The scraping-lambdas integration is functionally identical; only the constants (repo path, worktree base, result-file paths, channel ID) differ.

## Layout
- `scraping-lambdas/` — main repo clone (READ-ONLY, stays on `main`)
- `worktrees/<branch-name>/` — one git worktree per task/branch
- `discord-message-exchange.md` — channel-level message log
- `discord-thread-logs/<branch-name>.md` — one log per thread/worktree
- `CLAUDE.md` — instructions consumed by the in-worktree Claude Code agent
- `README.md` — this file

## Handler
Implementation: `src/handlers/scraping-lambdas.ts` in the bot repo, dispatched from `src/bot.ts` based on `message.channelId` and `channel.parentId`.

## Result files (IPC between bot and Claude)
- `/tmp/claude-code-worktree-scraping-lambdas.md` — written by Step 1 (worktree management)
- `/tmp/claude-code-result-scraping-lambdas.md` — written by Step 2 / maintenance / follow-ups
- `/tmp/claude-code-route-scraping-lambdas.json` — written by the LLM router
All three are deleted before every invocation.

## Environment Variables
Set in `.env` in the bot repo root:
- `SCRAPING_LAMBDAS_CHANNEL` — Discord channel ID that triggers this workflow (`1493070478577897543`)
- `SCRAPING_LAMBDAS_MAIN_REPO` — main repo path (`/home/ubuntu/discord-claude-bot/scraping-lambdas/scraping-lambdas`)
- `SCRAPING_LAMBDAS_WORKTREE_BASE` — worktree base dir (`/home/ubuntu/discord-claude-bot/scraping-lambdas/worktrees`)
- `SCRAPING_LAMBDAS_THREAD_LOGS_DIR` — thread log dir
- `SCRAPING_LAMBDAS_EXCHANGE_LOG` — channel log file

## Quality checks
scraping-lambdas is a monorepo with no top-level package.json. Each subproject (`morningstar-etfs/`, `stockanalysis-etfs/`, `stockanalysis-stocks/`, `stockanalysis-daily-movers/`) has its own `yarn compile` / `yarn prettier-check` / `yarn lint-fix`. The in-worktree agent runs these inside the affected subproject folder only.
