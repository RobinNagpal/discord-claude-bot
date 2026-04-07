# Discord Claude Bot

A Discord bot that bridges messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, with channel-based routing for specialized agent workflows.

## How It Works

Users send `!claude <prompt>` in Discord. The bot spawns a `claude -p` subprocess, captures the output, and replies with the result. Specific channels are routed to specialized handlers with project-specific context.

## Channel Routing

| Channel ID | Handler | Description |
|---|---|---|
| `1491102767224324309` | **Insights-UI** | Two-step git worktree workflow for the KoalaGains (insights-ui) project in the DoDAO monorepo. Manages worktrees, delegates coding, creates PRs. |
| `1491111325173022933` | **Outreach-Data** | Email outreach campaign automation. Collects contacts, composes emails, sends via Gmail, manages followups via Google Sheets. |
| Any other channel | **General** | Direct pass-through to `claude -p` with no special context. |

## Project Structure

```
discord-claude-bot/
├── src/
│   └── bot.ts              # Main bot (TypeScript, strict mode)
├── insights-ui/
│   └── CLAUDE.md           # Insights-UI agent docs (worktree workflow, build commands)
├── outreach-data/
│   └── CLAUDE.md           # Outreach-Data agent docs (campaigns, Gmail/Sheets integration)
├── .github/
│   └── workflows/
│       └── ci.yml          # CI: typecheck, lint, prettier, build
├── .env.example            # All configurable env vars with defaults
├── .prettierrc             # Prettier config (160 char width)
├── eslint.config.mjs       # ESLint strict + stylistic + prettier compat
├── tsconfig.json           # TypeScript strict config
└── package.json
```

## Setup

### 1. Discord Bot

1. Go to https://discord.com/developers/applications and create a new application
2. Under **Bot**, enable the **Message Content Intent**
3. Copy the bot token
4. Invite the bot to your server with `Send Messages` and `Read Messages` permissions

### 2. Install

```bash
git clone git@github.com:RobinNagpal/discord-claude-bot.git
cd discord-claude-bot
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:
- `DISCORD_TOKEN` — your bot token (required)
- `ALLOWED_USERS` — comma-separated Discord user IDs (recommended for security)

See `.env.example` for all available options.

### 4. Build and Run

```bash
npm run build
npm start
```

For development with auto-recompile:
```bash
npm run dev
```

## Usage

In any Discord channel the bot can see:

```
!claude explain how async/await works in JavaScript
```

In the insights-ui channel (`1491102767224324309`):

```
!claude fix the broken auth redirect on the login page
```

In the outreach-data channel (`1491111325173022933`):

```
!claude collect contacts for e-degree universities in Texas
```

## Available Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled bot |
| `npm run dev` | Watch mode (recompile on save) |
| `npm run lint` | ESLint check |
| `npm run lint:fix` | ESLint auto-fix |
| `npm run prettier` | Prettier check (160 char width) |
| `npm run prettier:fix` | Prettier auto-format |
| `npm run typecheck` | Type check without emitting |

## Prerequisites

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Discord bot token with Message Content Intent enabled
