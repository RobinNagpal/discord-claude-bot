import fs from "fs";
import path from "path";
import type { Client, TextChannel } from "discord.js";
import type { JobActiveWindow, JobConfig, JobHandler, JobRunResult } from "./types.js";
import { runClaude } from "../claude.js";
import { splitMessage } from "../discord.js";

interface LoadedJob {
  id: string;
  config: JobConfig;
  handler: JobHandler;
  nextRunAt: number;
  lastRunAt: number | null;
  consecutiveErrors: number;
}

const TICK_INTERVAL_MS = 30_000; // check every 30 seconds

const jobs: LoadedJob[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;
let discordClient: Client | null = null;

export async function startJobScheduler(client: Client): Promise<void> {
  discordClient = client;
  await loadJobs();

  const enabledCount = jobs.filter((j) => j.config.enabled).length;
  console.log(`Job scheduler started: ${jobs.length} jobs loaded, ${enabledCount} enabled`);

  tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopJobScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  console.log("Job scheduler stopped");
}

export function getJobs(): readonly LoadedJob[] {
  return jobs;
}

async function loadJobs(): Promise<void> {
  // Handlers are compiled to dist/jobs/, configs stay in src/jobs/
  const compiledJobsDir = import.meta.dirname;
  const sourceJobsDir = path.resolve(compiledJobsDir, "../../src/jobs");

  await discoverJobs(compiledJobsDir, sourceJobsDir, "");
}

async function discoverJobs(compiledBase: string, sourceBase: string, relativePath: string): Promise<void> {
  const compiledDir = path.join(compiledBase, relativePath);

  if (!fs.existsSync(compiledDir)) return;

  const entries = fs.readdirSync(compiledDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const childRelative = path.join(relativePath, entry.name);
    const configPath = path.join(sourceBase, childRelative, "config.json");
    const handlerPath = path.join(compiledBase, childRelative, "handler.js");

    if (fs.existsSync(configPath) && fs.existsSync(handlerPath)) {
      // This directory is a job (has both config.json and handler.js)
      try {
        const configRaw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(configRaw) as JobConfig;

        const handlerModule = (await import(handlerPath)) as { default: JobHandler };
        const handler = handlerModule.default;

        const jobId = childRelative.replace(/[\\/]/g, "/");
        jobs.push({
          id: jobId,
          config,
          handler,
          nextRunAt: computeNextRun(config),
          lastRunAt: null,
          consecutiveErrors: 0,
        });
      } catch (err) {
        console.error(`Failed to load job "${childRelative}":`, err);
      }
    } else {
      // Not a job — recurse into subdirectories
      await discoverJobs(compiledBase, sourceBase, childRelative);
    }
  }
}

function computeNextRun(config: JobConfig): number {
  const now = Date.now();

  if (config.schedule.kind === "every") {
    return now + config.schedule.everyMs;
  }

  // For cron schedules, compute next match
  return now + parseCronToNextMs(config.schedule.expr);
}

function parseCronToNextMs(expr: string): number {
  // Simplified cron parser — computes rough next run from cron expression
  // For production, consider a library like cron-parser
  const parts = expr.split(" ");
  if (parts.length !== 5) return 60_000;

  const minute = parts[0] === "*" ? -1 : parseInt(parts[0], 10);
  const hour = parts[1] === "*" ? -1 : parseInt(parts[1], 10);

  const now = new Date();
  const target = new Date(now);

  if (hour >= 0) target.setHours(hour);
  if (minute >= 0) target.setMinutes(minute);
  target.setSeconds(0);
  target.setMilliseconds(0);

  // If target is in the past, push to next day
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

async function tick(): Promise<void> {
  const now = Date.now();

  for (const job of jobs) {
    if (!job.config.enabled) continue;
    if (now < job.nextRunAt) continue;

    // Schedule next run immediately to prevent double-firing
    if (job.config.schedule.kind === "every") {
      job.nextRunAt = now + job.config.schedule.everyMs;
    } else {
      job.nextRunAt = now + parseCronToNextMs(job.config.schedule.expr);
    }

    if (!isInActiveWindow(job.config.activeWindow, new Date(now))) {
      continue;
    }

    // Fire and forget — don't block the tick loop
    void executeJob(job);
  }
}

function isInActiveWindow(window: JobActiveWindow | undefined, now: Date): boolean {
  if (!window) return true;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const rawHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const hour = rawHour === 24 ? 0 : rawHour;

  const dow = dayMap[weekday] ?? -1;
  if (window.daysOfWeek && !window.daysOfWeek.includes(dow)) return false;

  const nowMin = hour * 60 + minute;
  const startMin = window.startHour * 60 + (window.startMinute ?? 0);
  const endMin = window.endHour * 60 + (window.endMinute ?? 0);
  return nowMin >= startMin && nowMin < endMin;
}

async function executeJob(job: LoadedJob): Promise<void> {
  const startedAt = Date.now();
  console.log(`[job:${job.id}] Starting: ${job.config.name}`);

  const result: JobRunResult = {
    jobId: job.id,
    jobName: job.config.name,
    startedAt,
    finishedAt: 0,
    durationMs: 0,
    status: "ok",
    summary: "",
  };

  try {
    const prompt = job.handler.buildPrompt(job.config);
    await runClaude(prompt, { cwd: job.config.workspace });

    // Read result file
    try {
      result.summary = fs.readFileSync(job.config.resultFile, "utf-8");
    } catch {
      result.summary = "(No result file produced)";
    }

    job.consecutiveErrors = 0;
  } catch (err) {
    result.status = "error";
    result.summary = err instanceof Error ? err.message : String(err);
    job.consecutiveErrors++;
    console.error(`[job:${job.id}] Failed (consecutive: ${job.consecutiveErrors}):`, result.summary.slice(0, 200));
  }

  result.finishedAt = Date.now();
  result.durationMs = result.finishedAt - startedAt;
  job.lastRunAt = result.finishedAt;

  console.log(`[job:${job.id}] Finished in ${result.durationMs}ms — ${result.status}`);

  // Write run log
  appendRunLog(result);

  // Notify Discord if configured
  if (job.config.discord.notify && discordClient) {
    await notifyDiscord(job, result);
  }
}

function appendRunLog(result: JobRunResult): void {
  const logsDir = path.resolve(import.meta.dirname, "../../logs");
  const logFile = path.join(logsDir, `${result.jobId}.jsonl`);
  const logFileDir = path.dirname(logFile);

  if (!fs.existsSync(logFileDir)) {
    fs.mkdirSync(logFileDir, { recursive: true });
  }

  const line = JSON.stringify(result) + "\n";
  fs.appendFileSync(logFile, line);
}

async function notifyDiscord(job: LoadedJob, result: JobRunResult): Promise<void> {
  if (!discordClient) return;

  try {
    const channel = await discordClient.channels.fetch(job.config.discord.channelId);
    if (!channel?.isTextBased()) return;

    const prefix = result.status === "ok" ? `**[Job: ${job.config.name}] Complete**` : `**[Job: ${job.config.name}] Failed**`;
    const text = `${prefix}\n\n${result.summary}`;

    for (const chunk of splitMessage(text)) {
      await (channel as TextChannel).send(chunk);
    }
  } catch (err) {
    console.error(`[job:${job.id}] Discord notification failed:`, err);
  }
}
