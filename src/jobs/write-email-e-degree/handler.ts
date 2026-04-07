import type { JobHandler } from "../types.js";
import { buildOutreachJobPrompt } from "../outreach-prompt.js";
import config from "./config.json" with { type: "json" };
import type { JobConfig } from "../types.js";

const handler: JobHandler = {
  buildPrompt(): string {
    return buildOutreachJobPrompt(config as unknown as JobConfig, {
      taskFile: "cron-tasks/write-email-e-degree.md",
      strictLimit: false,
      doneMessage: "Done: Wrote emails for e-degree",
    });
  },
};

export default handler;
