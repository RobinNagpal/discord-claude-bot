# Scheduled Jobs

How the built-in job scheduler works, and how to add a new recurring job.

If you're looking for how Discord messages are routed to handlers, see [`routing.md`](./routing.md). Jobs and routing are independent — jobs don't receive Discord messages; they're triggered purely by time.

---

## 1. What this is (and what it isn't)

The bot has an **in-process job scheduler** that auto-discovers jobs on startup and ticks every 30 seconds. It's intentionally minimal:

- **No system cron, no OS-level scheduler.** Everything runs inside the bot process. Restart the bot, the scheduler restarts with it.
- **No new dependencies.** Uses only Node's built-ins (`setInterval`, `Intl.DateTimeFormat`).
- **Not a full cron implementation.** The included cron parser is a shallow placeholder — see [§6 Gotchas](#6-gotchas).
- **Not durable.** If the bot is down when a job should have fired, that fire is missed (no catch-up). Acceptable because the bot is typically always up (systemd `Restart=on-failure`).

Implementation: **`src/jobs/jobs.ts`** (scheduler), **`src/jobs/types.ts`** (types).

---

## 2. Anatomy of a job

A job lives in its own directory under `src/jobs/` (nesting allowed — e.g. `src/jobs/amb-prgm/send-email/`). It has exactly two files:

| File | Purpose |
|---|---|
| `config.json` | Schedule, workspace, Discord target, enabled flag. Validated against `JobConfig` in `types.ts`. |
| `handler.ts` | Exports a default `JobHandler` whose `buildPrompt(config)` returns the Claude prompt. |

Discovery (`src/jobs/jobs.ts:45-93`) walks `dist/jobs/` recursively looking for directories that have **both** `config.json` (in `src/jobs/`) **and** the compiled `handler.js` (in `dist/jobs/`). Other directories are recursed into but ignored themselves. That's why you can nest jobs inside campaign-grouping folders without anything special.

### Two-directory layout

Configs live in **`src/jobs/`** (committed, edited by humans). Compiled handlers live in **`dist/jobs/`** (produced by `tsc`). The scheduler reads each from its respective tree — so if you add a new job you **must run `npm run build`** before the scheduler will pick up the handler.

---

## 3. `config.json` schema

All fields defined in `src/jobs/types.ts`:

```jsonc
{
  // Human-friendly label for logs and Discord messages
  "name": "Send email in amb-prgm",

  // If false, the scheduler loads the job but never fires it
  "enabled": false,

  // Free-form text; not used programmatically
  "description": "Send exactly 1 outreach email every 10 minutes",

  // One of the two schedule shapes below — see §4
  "schedule": { "kind": "every", "everyMs": 600000 },

  // Optional: restricts firing to a weekday/hour window in a specific timezone — see §5
  "activeWindow": {
    "timezone": "America/New_York",
    "daysOfWeek": [1, 2, 3, 4, 5],
    "startHour": 6,
    "endHour": 15
  },

  // Passed as cwd to the Claude subprocess
  "workspace": "/home/ubuntu/.openclaw/workspace-outreach-data",

  // File the handler is expected to write. The scheduler reads it after Claude returns
  // and posts its contents to Discord (when discord.notify is true).
  "resultFile": "/tmp/claude-code-result-outreach-data.md",

  "discord": {
    "channelId": "1491111325173022933",
    "notify": true
  }
}
```

**Do NOT** add extra fields — they'll be silently ignored. **Do NOT** use comments in real JSON — the schema above is annotated for documentation only.

---

## 4. Schedule kinds

### `"every"` — fixed interval

```json
{ "kind": "every", "everyMs": 1800000 }
```

`everyMs` is milliseconds between fires. Measured from the last tick that fired this job (or from the bot's startup for the first fire). Good for "every 30 min", "every hour", etc.

**First fire is `everyMs` after bot startup**, not immediately. If `everyMs: 1800000` and the bot started at 09:17, the first fire is around 09:47.

### `"cron"` — time-of-day

```json
{ "kind": "cron", "expr": "15 9 * * *", "tz": "UTC" }
```

**The built-in parser only reads minute and hour**, and only as `*` or a single integer. The day-of-month, month, and day-of-week fields are **ignored**. Lists (`0,30`) and ranges (`6-14`) are **not supported** — only `*` or a single number.

In practice: use `cron` only for "once a day at HH:MM" patterns. For anything more complex, use `every` with an `activeWindow` (see §5).

> **Note:** The `tz` field is accepted by the type but **currently ignored** — cron times are interpreted in the Node process's local timezone. If you need timezone-awareness, use `activeWindow`.

---

## 5. `activeWindow` — restrict firing to a window

Optional gate that runs **after** `nextRunAt` has already advanced. If the gate says "no", the handler isn't invoked for this tick — but the schedule keeps ticking forward normally.

```json
"activeWindow": {
  "timezone": "America/New_York",
  "daysOfWeek": [1, 2, 3, 4, 5],
  "startHour": 6,
  "startMinute": 0,
  "endHour": 15,
  "endMinute": 0
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `timezone` | IANA name | yes | e.g. `"America/New_York"`, `"Asia/Kolkata"`, `"UTC"`. Resolved via `Intl.DateTimeFormat`. |
| `daysOfWeek` | `number[]` | no | `0=Sun … 6=Sat`. Omit to allow all days. |
| `startHour` / `endHour` | `0–23` | yes | Hours in the given timezone. |
| `startMinute` / `endMinute` | `0–59` | no, default `0` | Use for boundaries like `09:30`. |

**Inclusive start, exclusive end.** A window of `startHour: 6, endHour: 15` fires from `06:00` up to but not including `15:00`, so the last possible fire lands between `14:30` and `15:00`.

Implementation: `isInActiveWindow()` in `src/jobs/jobs.ts`. It uses `Intl.DateTimeFormat("en-US", { timeZone, weekday, hour, minute, hour12: false })` to get the local time in the target timezone — no external tz library needed.

### When to use `activeWindow`

- You want a job to run every `N` minutes, but only during business hours or weekdays.
- You want timezone-correct firing (the cron parser doesn't honor `tz`).
- You want to combine interval firing with an easy on/off schedule.

See `src/jobs/claude-usage/config.json` for a real example.

---

## 6. The tick loop (`src/jobs/jobs.ts:131-152`)

```ts
async function tick(): Promise<void> {
  const now = Date.now();

  for (const job of jobs) {
    if (!job.config.enabled) continue;
    if (now < job.nextRunAt) continue;

    // 1. Advance nextRunAt BEFORE firing (prevents double-fire if tick takes long)
    if (job.config.schedule.kind === "every") {
      job.nextRunAt = now + job.config.schedule.everyMs;
    } else {
      job.nextRunAt = now + parseCronToNextMs(job.config.schedule.expr);
    }

    // 2. Gate on activeWindow — skip execution but keep ticking
    if (!isInActiveWindow(job.config.activeWindow, new Date(now))) continue;

    // 3. Fire and forget — don't block the tick loop
    void executeJob(job);
  }
}
```

The tick interval is `TICK_INTERVAL_MS = 30_000` (30s). That's the resolution of the scheduler — a `"every": 10000` (10s) job will still only fire every 30s at most. Don't rely on sub-minute precision.

`executeJob` runs `runClaude(prompt, { cwd })`, reads `resultFile`, logs the run to `logs/{job-id}.jsonl`, and posts to Discord if `notify: true`.

---

## 7. The handler contract

```ts
// src/jobs/types.ts
export interface JobHandler {
  buildPrompt(config: JobConfig): string;
}
```

That's the entire interface. `buildPrompt` receives the parsed config and returns a single string that will be passed to `claude -p`. Handlers don't do IO directly — Claude does the work.

Typical handler (`src/jobs/amb-prgm/send-email/handler.ts`):

```ts
import type { JobConfig, JobHandler } from "../../types.js";
import { buildOutreachJobPrompt } from "../../outreach-prompt.js";

const handler: JobHandler = {
  buildPrompt(config: JobConfig): string {
    return buildOutreachJobPrompt(config, {
      taskFile: "cron-tasks/send-email-amb-prgm.md",
      strictLimit: true,
      doneMessage: "Done: Sent 1 amb-prgm email",
    });
  },
};

export default handler;
```

The `default` export is **required** — `import(handlerPath)` reads `module.default` (`src/jobs/jobs.ts:73-74`).

### What the prompt should instruct Claude to do

- Execute the task (in the workspace given as `cwd`).
- Write the **final summary** to `config.resultFile` — this is the source of truth for what gets posted to Discord. Stdout from Claude is discarded.
- Keep the summary concise when `notify: true` (Discord caps messages at 2000 chars; `splitMessage` handles longer output but shorter is better).

---

## 8. Adding a new job — step by step

1. **Pick a location.** Decide if it belongs in an existing campaign folder (`src/jobs/amb-prgm/`, `src/jobs/e-degree/`, etc.) or deserves a new top-level directory. If unsure, flat is fine — nesting is purely organizational.

2. **Create the directory.**
   ```bash
   mkdir src/jobs/<your-job-name>
   ```

3. **Write `config.json`.** Start disabled (`"enabled": false`) until you've verified it works.
   ```json
   {
     "name": "Short label",
     "enabled": false,
     "description": "What this job does",
     "schedule": { "kind": "every", "everyMs": 3600000 },
     "workspace": "/absolute/path/the/agent/should/cwd/into",
     "resultFile": "/tmp/claude-code-result-<your-job-name>.md",
     "discord": { "channelId": "<channel-id>", "notify": true }
   }
   ```

4. **Write `handler.ts`.** It must export a default `JobHandler`.
   ```ts
   import type { JobConfig, JobHandler } from "../types.js";

   const handler: JobHandler = {
     buildPrompt(config: JobConfig): string {
       return `Do X. Write the summary to ${config.resultFile}. Keep it under 15 lines.`;
     },
   };

   export default handler;
   ```
   The relative path to `../types.js` depends on nesting depth. For `src/jobs/foo/handler.ts` it's `../types.js`; for `src/jobs/group/foo/handler.ts` it's `../../types.js`. (These resolve at the compiled `dist/jobs/...` path, so the `.js` extension is intentional even though the source is `.ts` — the project is ESM.)

5. **Build.**
   ```bash
   npm run typecheck && npm run lint && npm run prettier
   npm run build
   ```
   The build step compiles `handler.ts` into `dist/jobs/<your-job-name>/handler.js`, which is what the scheduler actually loads.

6. **Test locally with `enabled: false`.** Start the bot (`npm start`) and check the startup log. You should see:
   ```
   Job scheduler started: N jobs loaded, M enabled
   ```
   with `N` incremented by 1. A disabled job loads but never fires — this confirms discovery worked. Then temporarily flip `enabled: true`, lower `everyMs` to something short (e.g. `60000` for 1 minute), and watch the logs / Discord channel for an actual fire.

7. **Flip `enabled: true` permanently**, restore the intended schedule, rebuild, and let systemd restart the bot (`systemctl --user restart discord-claude-bot`).

---

## 9. Debugging and logs

- **Startup log** — `Job scheduler started: N jobs loaded, M enabled` and, for each discovered job: `[startup] loaded job "<id>"` only appears on load failures. To confirm your job loaded successfully, check that the enabled count changed.

- **Per-run log** — `logs/<job-id>.jsonl` contains one JSON line per run with `status`, `durationMs`, and `summary` (the contents of the result file, truncated). This is the fastest way to confirm fires.

- **Bot journal** — via systemd: `journalctl --user -u discord-claude-bot -f`. Each fire emits `[job:<id>] Starting: <name>` and `[job:<id>] Finished in <ms>ms — ok`.

- **Discord notifications** failing silently — check `console.error(\`[job:${job.id}] Discord notification failed:\`, err)` in the journal. Common causes: bot lacks permission in the target channel, channel ID typo, channel is not text-based.

- **Job never fires** — usually one of: `"enabled": false`; `npm run build` wasn't run after editing `handler.ts`; the handler threw at import time (check journal for load errors); the `activeWindow` is excluding current time; the cron `expr` has more than the two fields the parser handles.

---

## 10. Gotchas

1. **The cron parser is deliberately minimal.** Don't write `0,30 6-14 * * 1-5` expecting it to work — the parser will take `0,30` as `NaN` and fall back to the zeroth position. For anything beyond "once a day at HH:MM", use `every` + `activeWindow`.

2. **`resultFile` is not cleared between runs.** If a fire fails before writing, the scheduler will read and post the *previous* run's result. If this matters for your job, your handler prompt should `rm -f` it first.

3. **`workspace` matters.** Claude's `CLAUDE.md` files are auto-loaded from the workspace directory and its ancestors. A job pointed at `/home/ubuntu` has no project context; a job pointed at `/home/ubuntu/.openclaw/workspace-outreach-data` inherits that workspace's instructions. Pick deliberately.

4. **Fires are fire-and-forget.** A long-running job (e.g. one that times out) does **not** block the tick loop. Two concurrent fires of the same job are possible if a run takes longer than its interval — don't rely on exclusion.

5. **The scheduler has no retry.** On error, `consecutiveErrors` increments and the summary says "error", but the next scheduled fire proceeds normally. Persistent failures accumulate in `consecutiveErrors` but nothing (currently) alerts on them.

6. **Handlers are loaded once at startup.** Editing `handler.ts` at runtime has no effect until you rebuild **and** restart the bot. Config reloading likewise isn't hot — there is no watcher.

7. **Tick interval = 30s.** This is the lower bound for schedule resolution. A job with `everyMs: 1000` will at best fire every 30 seconds.

---

## 11. Reference

| File | What |
|---|---|
| `src/jobs/jobs.ts` | Scheduler: discovery, tick loop, execution, notification |
| `src/jobs/types.ts` | `JobConfig`, `JobHandler`, `JobSchedule`, `JobActiveWindow`, `JobRunResult` |
| `src/jobs/outreach-prompt.ts` | Shared prompt builder used by outreach jobs |
| `src/jobs/<group>/<name>/config.json` | Per-job config |
| `src/jobs/<group>/<name>/handler.ts` | Per-job prompt builder |
| `logs/<job-id>.jsonl` | Per-job run history |
| `dist/jobs/...` | Compiled output (loaded at runtime) |
