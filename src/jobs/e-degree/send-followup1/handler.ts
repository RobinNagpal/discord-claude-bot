import type { JobConfig, JobHandler } from "../../types.js";
import { buildOutreachJobPrompt } from "../../outreach-prompt.js";

const handler: JobHandler = {
  buildPrompt(config: JobConfig): string {
    return buildOutreachJobPrompt(config, {
      taskFile: "cron-tasks/send-followup1-e-degree.md",
      strictLimit: true,
      doneMessage: "Done: Sent 1 e-degree 1st followup",
    });
  },
};

export default handler;
