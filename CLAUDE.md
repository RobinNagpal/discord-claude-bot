# CLAUDE.md

## Project Overview
Discord bot that bridges messages to Claude Code CLI with channel-based routing for specialized agent workflows. Written in TypeScript with strict types.

## Tech Stack
- **Runtime:** Node.js 20+
- **Language:** TypeScript (strict mode)
- **Framework:** discord.js
- **Linting:** ESLint (strict + stylistic rules via typescript-eslint)
- **Formatting:** Prettier (printWidth: 160)
- **CI:** GitHub Actions

## Project Structure
- `src/bot.ts` — Main bot entry point. All logic is in this single file.
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

### Channel Routing
The bot routes messages based on Discord channel ID:
- **Insights-UI channel** (`INSIGHTS_UI_CHANNEL`) -> `handleInsightsUI()` — Two-step git worktree workflow. Step 1 manages worktrees in the main repo, Step 2 runs the task in the selected worktree.
- **Outreach-Data channel** (`OUTREACH_DATA_CHANNEL`) -> `handleOutreachData()` — Spawns Claude Code in the outreach-data workspace with campaign context auto-detected from keywords.
- **All other channels** -> `handleGeneral()` — Simple pass-through to `claude -p`.

### How Claude Code Is Invoked
All handlers call `runClaude(prompt, cwd?)` which uses `child_process.execFile` to spawn `claude -p --dangerously-skip-permissions --output-format text <prompt>`. The optional `cwd` parameter sets the working directory for the subprocess.

### Key Constraints
- Discord messages are capped at 2000 chars. `splitMessage()` splits at newlines/spaces within a 1900-char limit.
- Concurrency is capped at `MAX_CONCURRENT` (default 3) active Claude processes.
- Claude subprocess timeout defaults to 5 minutes (`CLAUDE_TIMEOUT`).

## Adding a New Channel Route
1. Add env vars for the new channel ID and workspace path in `.env` / `.env.example`
2. Add constants at the top of `src/bot.ts`
3. Add an `else if` branch in the `messageCreate` handler
4. Create a `handle<Name>()` function following the pattern of existing handlers
5. Create a subfolder with a `CLAUDE.md` documenting the agent's workflow
