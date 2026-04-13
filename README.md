# Discord Claude Bot

A Discord bot that bridges messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, with channel-based routing for specialized agent workflows and a built-in job scheduler for recurring tasks.

## How It Works

Users send `!claude <prompt>` in Discord. The bot spawns a `claude -p` subprocess, captures the output, and replies with the result. Specific channels are routed to specialized handlers with project-specific context.

The bot also includes a job scheduler that runs recurring tasks (e.g. sending outreach emails) on configurable cron or interval schedules.

## Channel Routing

| Channel ID | Handler | Description |
|---|---|---|
| `1491102767224324309` | **Insights-UI** | Two-step git worktree workflow for the KoalaGains (insights-ui) project in the DoDAO monorepo. Manages worktrees, delegates coding, creates PRs. |
| `1491111325173022933` | **Outreach-Data** | Email outreach campaign automation. Collects contacts, composes emails, sends via Gmail, manages followups via Google Sheets. |
| `1491111325173022934` | **Gmail** | Ambassador program email workflows. Processes threads, exports to CSV, sends follow-up emails. |
| Any other channel | **General** | Direct pass-through to `claude -p` with no special context. |

## Project Structure

```
discord-claude-bot/
├── src/
│   ├── bot.ts                      # Entry point — Discord client, message routing
│   ├── config.ts                   # Environment variable parsing
│   ├── claude.ts                   # Claude Code CLI invocation
│   ├── discord.ts                  # Message splitting, error formatting
│   ├── result.ts                   # Result file reading utilities
│   ├── handlers/
│   │   ├── general.ts              # General pass-through handler
│   │   ├── gmail.ts                # Ambassador email workflow handler
│   │   ├── insights-ui.ts          # Two-step worktree workflow
│   │   └── outreach-data.ts        # Outreach campaign handler
│   └── jobs/
│       ├── types.ts                # Job type definitions
│       ├── jobs.ts                 # Job scheduler (recursive discovery, cron/interval)
│       ├── outreach-prompt.ts      # Shared outreach prompt builder
│       ├── amb-prgm/               # Ambassador program campaign
│       │   ├── send-email/         # config.json + handler.ts
│       │   ├── send-followup1/
│       │   └── send-followup2/
│       ├── e-degree/               # E-degree campaign
│           ├── send-email/
│           ├── send-followup1/
│           ├── send-followup2/
│           └── write-email/
│       └── gmail/                   # Gmail ambassador workflows
│           └── send-followup-amb-prgm/
├── gmail/
│   └── CLAUDE.md                   # Gmail agent workflow docs
├── insights-ui/
│   └── CLAUDE.md                   # Insights-UI agent workflow docs
├── outreach-data/
│   └── CLAUDE.md                   # Outreach-Data agent workflow docs
├── .github/workflows/ci.yml       # CI: typecheck, lint, prettier, build
├── .env.example                    # All configurable env vars
├── .prettierrc                     # Prettier (160 char width)
├── eslint.config.mjs               # ESLint strict + stylistic
├── tsconfig.json                   # TypeScript strict mode
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

### 5. Run as a Service (production)

To keep the bot running across SSH disconnects, crashes, and reboots, run it as a **systemd user service**.

Create `~/.config/systemd/user/discord-claude-bot.service`:

```ini
[Unit]
Description=Discord Claude Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/discord-claude-bot
ExecStart=/home/ubuntu/.nvm/versions/node/v22.22.0/bin/node dist/bot.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PATH=/home/ubuntu/.local/bin:/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/ubuntu

[Install]
WantedBy=default.target
```

Adjust `WorkingDirectory`, the `node` path in `ExecStart`, and the `PATH` (must include the `claude` and `gh` binaries) for your environment.

Enable, start, and make it survive logout:

```bash
npm run build
systemctl --user daemon-reload
systemctl --user enable --now discord-claude-bot
sudo loginctl enable-linger $USER     # keeps user services running after logout
```

Day-to-day operation:

```bash
systemctl --user status discord-claude-bot     # check status
systemctl --user restart discord-claude-bot    # restart (after a code change)
systemctl --user stop discord-claude-bot       # stop
journalctl --user -u discord-claude-bot -f     # tail logs
```

After any code change: `npm run build && systemctl --user restart discord-claude-bot`.

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

## Scheduled Jobs

The bot includes a job scheduler that runs recurring tasks automatically. Each job is a directory under `src/jobs/` containing:

- `config.json` — Schedule (cron or interval), workspace path, Discord notification settings, enabled flag
- `handler.ts` — Builds the Claude Code prompt for the task

Jobs are organized in campaign folders (`amb-prgm/`, `e-degree/`). All jobs are disabled by default — set `"enabled": true` in `config.json` to activate.

| Job | Schedule | Description |
|---|---|---|
| `amb-prgm/send-email` | Every 10 min | Send 1 ambassador program outreach email |
| `amb-prgm/send-followup1` | Every 10 min | Send 1st followup for amb-prgm |
| `amb-prgm/send-followup2` | Every 10 min | Send 2nd followup for amb-prgm |
| `e-degree/send-email` | Every 10 min | Send 1 e-degree outreach email |
| `e-degree/send-followup1` | Every 10 min | Send 1st followup for e-degree |
| `e-degree/send-followup2` | Every 10 min | Send 2nd followup for e-degree |
| `e-degree/write-email` | Every 10 min | Compose emails for 5 e-degree contacts |
| `gmail/send-followup-amb-prgm` | Every 10 min | Send 1 ambassador program follow-up email |

Run logs are written to `logs/{job-id}.jsonl`.

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
