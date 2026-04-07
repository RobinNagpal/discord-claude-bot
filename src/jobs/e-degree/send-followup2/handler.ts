import type { JobConfig, JobHandler } from "../../types.js";
import { buildOutreachJobPrompt } from "../../outreach-prompt.js";

const handler: JobHandler = {
  buildPrompt(config: JobConfig): string {
    return buildOutreachJobPrompt(config, {
      taskFile: "cron-tasks/send-followup2-e-degree.md",
      strictLimit: true,
      doneMessage: "Done: Sent 1 e-degree 2nd followup",
    });
  },
};

export default handler;
