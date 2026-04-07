import type { JobHandler } from "../types.js";
import { buildOutreachJobPrompt } from "../outreach-prompt.js";
import config from "./config.json" with { type: "json" };
import type { JobConfig } from "../types.js";

const handler: JobHandler = {
  buildPrompt(): string {
    return buildOutreachJobPrompt(config as unknown as JobConfig, {
      taskFile: "cron-tasks/send-followup1-e-degree.md",
      strictLimit: true,
      doneMessage: "Done: Sent 1 e-degree 1st followup",
    });
  },
};

export default handler;
