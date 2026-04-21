# Discord Message Routing

How a message sent in Discord gets turned into an action by the bot.

This doc covers the code paths under `src/bot.ts` and `src/handlers/`. If you change routing, update this file too.

---

## 1. High-level flow

```
Discord message
      │
      ▼
 bot.ts: messageCreate listener
      │  (prefix / attachment / allow-list checks)
      ▼
 Channel dispatcher
      │
      ├──► Worktree channels  (insights-ui, scraping-lambdas, discord-bot)
      │       │
      │       ├── main channel   → handleWorktreeChannelMessage (shared LLM router)
      │       └── thread         → per-handler thread follow-up (claude -c)
      │
      ├──► Outreach-data channel → handleOutreachData (direct pass-through)
      ├──► Gmail channel         → handleGmail         (direct pass-through)
      └──► Any other channel     → handleGeneral       (direct pass-through)
```

Two families of handlers exist:

- **Worktree handlers** use a two-stage design: an LLM classifier picks a typed command, then a dispatcher runs it (may spawn another Claude process inside a git worktree).
- **Simple handlers** pass the user text directly to `runClaude(prompt, { cwd })` with no classification step.

The doc below concentrates on the worktree-handler flow, which is the non-obvious part.

---

## 2. Pre-dispatch gates in `bot.ts`

The `messageCreate` listener (`src/bot.ts:95`) applies these checks **before** any handler runs:

| Check | Location | Rejects if |
|---|---|---|
| Author is a bot | `message.author.bot` | Prevents reply loops |
| Prefix / attachment | `message.content.startsWith(PREFIX)` OR has audio (in worktree threads) OR has files (in worktree threads) | Lets the message pass if `!claude` or attachments are present |
| `ALLOWED_CHANNELS` | from env | Only listed channel IDs are served (if set) |
| `ALLOWED_USERS` | from env | Only listed Discord user IDs may invoke the bot |
| Shutdown in progress | `shuttingDown` | Asks the user to resend later |
| Empty prompt | `!textPrompt && !hasAudio && !hasFiles` | Nothing to do |
| Concurrency limit | `activeJobs >= MAX_CONCURRENT` | Max 3 concurrent handlers by default |

If every gate passes, `activeJobs++` is incremented and the message enters the handler flow.

### Attachment preprocessing

Before the handler runs, two preprocessing steps may modify `prompt`:

1. **Audio transcription** — audio attachments in a worktree thread are transcribed via Gemini REST API (`src/audio.ts`). The transcript is appended to the prompt.
2. **File attachments** — non-audio attachments in a worktree thread are downloaded (`src/files.ts`). Text files are inlined into the prompt; binaries are saved to disk and referenced by path.

Both only trigger inside a worktree **thread** (not the main channel), because those threads are long-running sessions where attachment flow is ergonomic.

---

## 3. Channel dispatcher (`src/bot.ts:177-195`)

After preprocessing, one branch fires based on channel ID and thread parent:

```ts
if (inInsightsUiThread) {
  await handleInsightsUIThread(message, channel as ThreadChannel, prompt);
} else if (inScrapingLambdasThread) {
  await handleScrapingLambdasThread(message, channel as ThreadChannel, prompt);
} else if (inDiscordBotThread) {
  await handleDiscordBotThread(message, channel as ThreadChannel, prompt);
} else if (message.channelId === INSIGHTS_UI_CHANNEL) {
  await handleInsightsUI(message, prompt);
} else if (message.channelId === SCRAPING_LAMBDAS_CHANNEL) {
  await handleScrapingLambdas(message, prompt);
} else if (message.channelId === DISCORD_BOT_CHANNEL) {
  await handleDiscordBot(message, prompt);
} else if (message.channelId === OUTREACH_DATA_CHANNEL) {
  await handleOutreachData(message, prompt);
} else if (message.channelId === GMAIL_CHANNEL) {
  await handleGmail(message, prompt);
} else {
  await handleGeneral(message, prompt);
}
```

Threads are detected by `channel.type === PublicThread || PrivateThread` and matched to their parent worktree channel by `channel.parentId`.

---

## 4. Worktree channels (the shared pattern)

`insights-ui`, `scraping-lambdas`, and `discord-bot` all use the same two-stage design, implemented in **`src/handlers/worktree-channel.ts`** as a config-driven module.

Each per-project handler file (`src/handlers/insights-ui.ts`, `scraping-lambdas.ts`, `discord-bot.ts`) is a thin wrapper:

```ts
const CONFIG: WorktreeChannelConfig = {
  mainRepo, worktreeBase, worktreeResult, taskResult, routeResult,
  exchangeLog, threadLogsDir,
  startTaskLabel, threadReasonPrefix, routerProjectDescription,
  supportedCommandsHelp,
  initialTaskProjectContext, initialTaskQualityChecksLine, initialTaskSummaryExample,
};

export async function handleInsightsUI(message, userMessage) {
  await handleWorktreeChannelMessage(CONFIG, message, userMessage);
}
```

The shared module does all the work; the handler file only provides the project-specific strings and paths.

### 4.1 Main-channel flow (`handleWorktreeChannelMessage`)

```
1. Log the incoming message to exchange log
2. Delete any stale /tmp result files
3. Reply "Routing your request..."
4. Spawn Claude as a router:
     runClaude(buildRouterPrompt(config, userMessage), { cwd: mainRepo })
5. Read the router's JSON decision from config.routeResult
6. Parse with parseRouteDecision → RouteDecision
7. Dispatch based on decision.command
```

### 4.2 The router Claude

The router prompt (`buildRouterPrompt`) tells Claude:

- **Do not execute** the user's request — only classify it.
- Pick exactly one of the supported commands.
- Write a single JSON object to a project-specific result file (no markdown, no fences).

Supported commands (shape of the returned JSON):

| Command | JSON |
|---|---|
| Create a new coding task in a fresh worktree | `{"command":"new_task","task":"<restated task>"}` |
| List worktrees | `{"command":"list_worktrees"}` |
| Delete a specific worktree | `{"command":"delete_worktree","worktree":"<name>"}` |
| Prune stale worktree refs | `{"command":"prune_worktrees"}` |
| List PRs | `{"command":"list_prs","state":"open\|merged\|closed\|all"}` |
| Close a PR | `{"command":"close_pr","pr":<int>}` |
| Free-form maintenance | `{"command":"maintenance","instructions":"<restated request>"}` |
| Can't classify | `{"command":"unknown","reason":"<one-sentence reason>"}` |

`parseRouteDecision` (in `worktree-channel.ts`) strips code fences defensively, runs `JSON.parse`, and validates each shape. Invalid JSON or missing fields → `router_error`, which surfaces to the user.

### 4.3 Dispatch table

After a successful parse, `handleWorktreeChannelMessage` runs a `switch` on `decision.command`:

| Command | Sub-handler | What it does |
|---|---|---|
| `new_task` | `handleNewTask` | 2-step: (A) spawn a Claude in the main repo that creates a new worktree+branch via `git worktree add`; (B) create a Discord thread named after the branch; (C) spawn a second Claude **inside the new worktree** with the initial-task prompt; (D) post its result back to the thread. |
| `list_worktrees` | `runGit(["worktree","list"])` — direct, no Claude. |
| `delete_worktree` | `runGit(["worktree","remove",...])` + `git branch -D`. |
| `prune_worktrees` | `runGit(["worktree","prune","--verbose"])`. |
| `list_prs` | `runGh(["pr","list","--state",state,"--limit","30"])`. |
| `close_pr` | `runGh(["pr","close","<n>"])`. |
| `maintenance` | Spawn Claude in the main repo with the maintenance prompt (for multi-step ops the typed commands don't cover). |
| `unknown` | Reply with the help text. |

Only `new_task` and `maintenance` spawn additional Claude processes. Everything else is a direct `git`/`gh` call, so it returns in well under a second.

### 4.4 Concurrency note

The main-channel flow for a `new_task` command spawns **two** Claude processes in sequence (Step 1 in the main repo, Step 2 inside the worktree). Both count against the global `MAX_CONCURRENT=3` limit via `activeJobs`, because the whole flow runs inside one `messageCreate` invocation.

### 4.5 Thread follow-ups (per-handler)

Each worktree handler file owns its own thread handler: `handleInsightsUIThread`, `handleScrapingLambdasThread`, `handleDiscordBotThread`. They do **not** use the shared module's router — a thread message is always a follow-up to an in-progress task, not a new classification.

```
1. Map thread.name → worktrees/<thread.name>; fail fast if the worktree doesn't exist
2. Clear stale /tmp files; log the user message
3. Reply "Continuing session..."
4. Spawn Claude with:
     runClaude(buildFollowupPrompt(...), { cwd: worktreePath, continueSession: true })
   — continueSession adds the `-c` flag, which resumes the prior session in that cwd
5. Read the task-result file and post it back to the thread
```

The key difference from a main-channel message:

- **Main channel** → LLM classifier decides `new_task` vs maintenance vs listing vs …
- **Thread** → always a continuation; just run `claude -c -p` in the worktree with a prompt that includes the user's new message.

`buildFollowupPrompt` is project-specific (different quality-check commands per project) and lives in each handler file, not the shared module.

---

## 5. Logging and state

Each worktree handler writes to two log files so future sessions and humans can reconstruct what happened:

- **`exchangeLog`** (`discord-message-exchange.md` per workspace) — every main-channel message pair (user → claude).
- **`threadLogsDir/<branch>.md`** — every thread message pair for that branch.

Both are append-only markdown. The shared module's `appendChannelExchange` and `appendThreadExchange` do the writes; handlers call them at every relevant step.

Transient state uses `/tmp/` result files:

- `*_ROUTE_RESULT` — router's JSON output
- `*_WORKTREE_RESULT` — Step-1 output of `handleNewTask` (worktree path + branch)
- `*_TASK_RESULT` — the result the in-worktree Claude writes at the end

All three are deleted by `clearResultFiles(config)` at the start of each main-channel invocation, so a prior run can't leak into the next.

---

## 6. Simple (non-worktree) handlers

These handlers skip the LLM router entirely — they pass the user text straight to Claude.

### `handleGeneral` (`src/handlers/general.ts`)

One call: `runClaude(prompt)`. No cwd, no router, no logs. This is the default for any channel not listed above.

### `handleOutreachData` (`src/handlers/outreach-data.ts`)

Inspects the raw message for campaign keywords (`amb-prgm`, `e-degree`, etc.) to pick a context block, then spawns Claude with `cwd: OUTREACH_DATA_WORKSPACE`. No router, no worktree.

### `handleGmail` (`src/handlers/gmail.ts`)

Same pattern as outreach-data: auto-detect workflow from keywords, then a single Claude call in the Gmail workspace.

---

## 7. Key files

| File | What to look at when |
|---|---|
| `src/bot.ts` | Channel dispatch table; prefix/gate logic; concurrency counter |
| `src/handlers/worktree-channel.ts` | Router prompt, parser, dispatch switch, sub-handlers for worktree channels |
| `src/handlers/insights-ui.ts` | Insights-UI config + thread handler |
| `src/handlers/scraping-lambdas.ts` | Scraping-Lambdas config + thread handler |
| `src/handlers/discord-bot.ts` | Discord-Bot (self-update) config + thread handler |
| `src/handlers/general.ts` | Default pass-through |
| `src/handlers/outreach-data.ts` | Outreach campaign auto-detect + pass-through |
| `src/handlers/gmail.ts` | Gmail workflow auto-detect + pass-through |
| `src/claude.ts` | `runClaude()` — the subprocess wrapper used everywhere |
| `src/config.ts` | All env var parsing and project-specific paths |

---

## 8. Adding a new worktree channel

1. Add env vars + exported constants to `src/config.ts` (`*_CHANNEL`, `*_MAIN_REPO`, `*_WORKTREE_BASE`, `*_WORKTREE_RESULT`, `*_TASK_RESULT`, `*_ROUTE_RESULT`, `*_EXCHANGE_LOG`, `*_THREAD_LOGS_DIR`).
2. Create `src/handlers/<name>.ts`:
   - Import the constants and `handleWorktreeChannelMessage`, `appendThreadExchange`, `clearResultFiles` from `./worktree-channel.js`.
   - Build a `WorktreeChannelConfig` object (see existing handlers for examples).
   - Write a project-specific `buildFollowupPrompt(message, worktreePath, branchName)`.
   - Export `handleX` (delegates to `handleWorktreeChannelMessage(CONFIG, ...)`) and `handleXThread` (follow-up flow).
3. Wire up in `src/bot.ts`:
   - Import the new handlers.
   - Add `parentId === <CHANNEL>` detection to the thread checks.
   - Add the `else if (message.channelId === <CHANNEL>)` and `inXThread` branches to the dispatcher.
4. Add a per-workspace `CLAUDE.md` documenting the in-worktree agent expectations.

No changes to `worktree-channel.ts` should be needed unless your project genuinely needs a new kind of routing behavior.
