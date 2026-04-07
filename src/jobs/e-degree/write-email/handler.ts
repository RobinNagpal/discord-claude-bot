import type { JobConfig, JobHandler } from "../../types.js";
import { buildOutreachJobPrompt } from "../../outreach-prompt.js";

const handler: JobHandler = {
  buildPrompt(config: JobConfig): string {
    return buildOutreachJobPrompt(config, {
      taskFile: "cron-tasks/write-email-e-degree.md",
      strictLimit: false,
      doneMessage: "Done: Wrote emails for e-degree",
    });
  },
};

export default handler;
