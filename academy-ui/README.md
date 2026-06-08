# Academy-UI Workspace

This directory hosts the Discord bot's integration with the [`academy-ui`](https://github.com/RobinNagpal/dodao-ui/tree/main/academy-ui) sub-app of the DoDAO UI monorepo. The bot orchestrates git worktrees and Discord threads so each task gets its own isolated branch + conversation, and Claude Code is invoked at the right moment with the right working directory.

Structure mirrors the `insights-ui/` workspace — see `insights-ui/README.md` for the canonical write-up of how the orchestration works. The academy-ui integration is functionally identical to insights-ui (both target sub-apps within the same `dodao-ui` monorepo); only the constants (separate repo clone path, worktree base, result-file paths, channel ID) differ.

## Layout
- `dodao-ui/` — main repo clone (READ-ONLY, stays on `main`)
- `worktrees/<branch-name>/` — one git worktree per task/branch
- `discord-message-exchange.md` — channel-level message log
- `discord-thread-logs/<branch-name>.md` — one log per thread/worktree
- `CLAUDE.md` — instructions consumed by the in-worktree Claude Code agent
- `README.md` — this file

## Handler
Implementation: `src/handlers/academy-ui.ts` in the bot repo, dispatched from `src/bot.ts` based on `message.channelId` and `channel.parentId`. The handler is a thin wrapper around the shared `handleWorktreeChannelMessage()` / thread-follow-up plumbing in `src/handlers/worktree-channel.ts`, identical to the `insights-ui` / `scraping-lambdas` / `discord-bot` / `place-items-on-shelf` handlers.

## Result files (IPC between bot and Claude)
- `/tmp/claude-code-worktree-academy-ui.md` — written by Step 1 (worktree management)
- `/tmp/claude-code-result-academy-ui.md` — written by Step 2 / maintenance / follow-ups
- `/tmp/claude-code-route-academy-ui.json` — written by the LLM router
All three are deleted before every invocation.

## Environment Variables
Set in `.env` in the bot repo root:
- `ACADEMY_UI_CHANNEL` — Discord channel ID that triggers this workflow (`1513512838759583834`)
- `ACADEMY_UI_MAIN_REPO` — main repo path (`/home/ubuntu/discord-claude-bot/academy-ui/dodao-ui`)
- `ACADEMY_UI_WORKTREE_BASE` — worktree base dir (`/home/ubuntu/discord-claude-bot/academy-ui/worktrees`)

## Initial setup (one-time, on the bot host)
The bot expects `ACADEMY_UI_MAIN_REPO` to already be a clone of `dodao-ui` on `main`. To bootstrap:
```bash
mkdir -p /home/ubuntu/discord-claude-bot/academy-ui
git clone https://github.com/RobinNagpal/dodao-ui.git /home/ubuntu/discord-claude-bot/academy-ui/dodao-ui
mkdir -p /home/ubuntu/discord-claude-bot/academy-ui/worktrees
```

## Quality checks
The in-worktree agent runs `yarn lint && yarn prettier-check && yarn build` from the repo root before committing — the same scripts the dodao-ui monorepo uses for the rest of its sub-apps.
