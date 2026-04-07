import type { JobConfig, JobHandler } from "../../types.js";

const handler: JobHandler = {
  buildPrompt(config: JobConfig): string {
    return `Read and follow the instructions in cron-tasks/send-followup-amb-prgm.md exactly.

ABSOLUTE LIMIT — READ THIS FIRST:
You MUST send exactly 1 email per invocation. This is non-negotiable.
- Process exactly 1 pending row from the CSV, then STOP
- Do NOT loop or batch multiple rows
- The cron scheduler handles pacing. Your only job is ONE email.

Environment setup (required for all gog commands):
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD=lollY.789

Sending account: ryan@koalagains.com

When completely finished:
1. Write summary to ${config.resultFile}
2. Run: openclaw system event --text "Done: Sent 1 follow-up email for campus_ambassador" --mode now`;
  },
};

export default handler;
