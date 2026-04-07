export interface CronSchedule {
  kind: "cron";
  expr: string;
  tz: string;
}

export interface IntervalSchedule {
  kind: "every";
  everyMs: number;
}

export type JobSchedule = CronSchedule | IntervalSchedule;

export interface JobDiscordConfig {
  channelId: string;
  notify: boolean;
}

export interface JobConfig {
  name: string;
  enabled: boolean;
  description: string;
  schedule: JobSchedule;
  workspace: string;
  resultFile: string;
  discord: JobDiscordConfig;
}

export interface JobRunResult {
  jobId: string;
  jobName: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  status: "ok" | "error";
  summary: string;
}

export interface JobHandler {
  buildPrompt(): string;
}
