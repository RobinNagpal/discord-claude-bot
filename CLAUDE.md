# CLAUDE.md

## Project Overview
Discord bot that bridges messages to Claude Code CLI with channel-based routing for specialized agent workflows, plus a built-in job scheduler for recurring tasks. Written in TypeScript with strict types.

## Tech Stack
- **Runtime:** Node.js 20+
- **Language:** TypeScript (strict mode, ESM)
- **Framework:** discord.js
- **Linting:** ESLint (strict + stylistic rules via typescript-eslint)
- **Formatting:** Prettier (printWidth: 160)
- **CI:** GitHub Actions

## Project Structure
```
src/
├── bot.ts                          # Entry point — Discord client setup, message routing
├── config.ts                       # Env parsing (requireEnv, optionalEnv, optionalEnvInt)
├── claude.ts                       # runClaude() — spawns claude CLI subprocess
├── discord.ts                      # splitMessage(), replyInChunks(), formatError()
├── result.ts                       # readResultFile(), extractField()
├── handlers/
│   ├── general.ts                  # General pass-through handler
│   ├── insights-ui.ts              # Two-step worktree workflow handler
│   └── outreach-data.ts            # Campaign auto-detection + outreach handler
└── jobs/
    ├── types.ts                    # JobConfig, JobSchedule, JobHandler, JobRunResult
    ├── jobs.ts                     # Scheduler — recursive discovery, cron/interval, Discord notify
    ├── outreach-prompt.ts          # Shared prompt builder for outreach jobs
    ├── amb-prgm/                   # Ambassador program campaign jobs
    │   ├── send-email/             # config.json + handler.ts
    │   ├── send-followup1/
    │   └── send-followup2/
    └── e-degree/                   # E-degree campaign jobs
        ├── send-email/
        ├── send-followup1/
        ├── send-followup2/
        └── write-email/
```

Other directories:
- `insights-ui/CLAUDE.md` — Context docs for the insights-ui (KoalaGains) agent workflow
- `outreach-data/CLAUDE.md` — Context docs for the outreach-data agent workflow
- `.env` / `.env.example` — Configuration (bot token, channel IDs, workspace paths)

## Build & Quality Commands
```bash
npm run build          # tsc — compile to dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src/
npm run lint:fix       # eslint src/ --fix
npm run prettier       # prettier --check src/
npm run prettier:fix   # prettier --write src/
npm start              # node dist/bot.js
```

**Before committing, always run:** `npm run typecheck && npm run lint && npm run prettier`

## Architecture

### Channel Routing (src/bot.ts)
The bot routes `!claude <prompt>` messages based on Discord channel ID:
- **Insights-UI channel** (`INSIGHTS_UI_CHANNEL`) -> `handleInsightsUI()` — Two-step git worktree workflow. Step 1 manages worktrees in the main repo, Step 2 runs the task in the selected worktree.
- **Outreach-Data channel** (`OUTREACH_DATA_CHANNEL`) -> `handleOutreachData()` — Spawns Claude Code in the outreach-data workspace with campaign context auto-detected from keywords.
- **All other channels** -> `handleGeneral()` — Simple pass-through to `claude -p`.

### How Claude Code Is Invoked (src/claude.ts)
All handlers call `runClaude(prompt, { cwd })` which uses `child_process.execFile` to spawn `claude -p --dangerously-skip-permissions --output-format text <prompt>`. The optional `cwd` sets the working directory.

### Job Scheduler (src/jobs/jobs.ts)
- Auto-discovers jobs by recursively scanning for directories with `config.json` + `handler.ts`
- Supports nested folders (e.g. `amb-prgm/send-email/`)
- Two schedule types: `"kind": "cron"` (cron expression) and `"kind": "every"` (interval in ms)
- Ticks every 30s, fires due jobs, logs results to `logs/{job-id}.jsonl`
- Optionally notifies Discord channel on completion
- Config JSON stays in `src/`, compiled handlers loaded from `dist/`

### Key Constraints
- Discord messages are capped at 2000 chars. `splitMessage()` splits at newlines/spaces within a 1900-char limit.
- Concurrency is capped at `MAX_CONCURRENT` (default 3) active Claude processes (message handlers only, not jobs).
- Claude subprocess timeout defaults to 5 minutes (`CLAUDE_TIMEOUT`).

## Adding a New Channel Route
1. Add env vars for the new channel ID and workspace path in `.env` / `.env.example` and `src/config.ts`
2. Add an `else if` branch in the `messageCreate` handler in `src/bot.ts`
3. Create a `handle<Name>()` function in `src/handlers/<name>.ts`
4. Create a subfolder with a `CLAUDE.md` documenting the agent's workflow

## Adding a New Scheduled Job
1. Create `src/jobs/<group>/<job-name>/config.json` with schedule, workspace, resultFile, discord config
2. Create `src/jobs/<group>/<job-name>/handler.ts` exporting a default `JobHandler` with `buildPrompt(config)`
3. The scheduler discovers it automatically on next startup
4. Set `"enabled": true` in config.json to activate
