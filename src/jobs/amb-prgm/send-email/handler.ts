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
