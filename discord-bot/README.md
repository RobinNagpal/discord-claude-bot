# Discord-Claude-Bot Workspace

This directory hosts the Discord bot's integration with its **own codebase** — allowing the bot to modify itself through Discord messages. The bot orchestrates git worktrees and Discord threads so each task gets its own isolated branch + conversation, and Claude Code is invoked at the right moment with the right working directory.

Structure mirrors the `insights-ui/` workspace — see `insights-ui/README.md` for the canonical write-up of how the orchestration works. The discord-claude-bot integration is functionally identical; only the constants (repo path, worktree base, result-file paths, channel ID) differ.

## Layout
- `discord-claude-bot/` — main repo clone (READ-ONLY, stays on `main`)
- `worktrees/<branch-name>/` — one git worktree per task/branch
- `discord-message-exchange.md` — channel-level message log
- `discord-thread-logs/<branch-name>.md` — one log per thread/worktree
- `CLAUDE.md` — instructions consumed by the in-worktree Claude Code agent
- `README.md` — this file

## Handler
Implementation: `src/handlers/discord-bot.ts` in the bot repo, dispatched from `src/bot.ts` based on `message.channelId` and `channel.parentId`.

## Result files (IPC between bot and Claude)
- `/tmp/claude-code-worktree-discord-bot.md` — written by Step 1 (worktree management)
- `/tmp/claude-code-result-discord-bot.md` — written by Step 2 / maintenance / follow-ups
- `/tmp/claude-code-route-discord-bot.json` — written by the LLM router
All three are deleted before every invocation.

## Environment Variables
Set in `.env` in the bot repo root:
- `DISCORD_BOT_CHANNEL` — Discord channel ID that triggers this workflow (`1494631048414236734`)
- `DISCORD_BOT_MAIN_REPO` — main repo clone path (`/home/ubuntu/discord-claude-bot/discord-bot/discord-claude-bot`)
- `DISCORD_BOT_WORKTREE_BASE` — worktree base dir (`/home/ubuntu/discord-claude-bot/discord-bot/worktrees`)
- `DISCORD_BOT_THREAD_LOGS_DIR` — thread log dir
- `DISCORD_BOT_EXCHANGE_LOG` — channel log file

## Quality checks
This is a standard TypeScript project with npm. Quality checks run at the top level:
- `npm run typecheck` — TypeScript strict mode
- `npm run lint` — ESLint with strict + stylistic rules
- `npm run prettier` — Prettier (printWidth: 160)
