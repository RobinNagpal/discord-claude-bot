import type { JobConfig } from "./types.js";

interface OutreachPromptOptions {
  taskFile: string;
  strictLimit: boolean;
  doneMessage: string;
}

export function buildOutreachJobPrompt(config: JobConfig, options: OutreachPromptOptions): string {
  const limitBlock = options.strictLimit
    ? `ABSOLUTE LIMIT — READ THIS FIRST:
You MUST send exactly 1 email per invocation. This is non-negotiable.
- Run the find-eligible Python script exactly ONCE
- Process the single row it returns, send the email, update the sheet
- Then IMMEDIATELY write the summary and exit
- Do NOT run the script a second time to "check for more"
- Do NOT loop, iterate, or batch multiple contacts
- The cron scheduler handles pacing. Your only job is ONE email.
- CRITICAL: Do NOT escape apostrophes or quotes in SUBJECT or BODY. Pass them exactly as-is.

`
    : "";

  return `${limitBlock}Read and follow the instructions in ${options.taskFile} exactly.

Environment setup (required for all gog commands):
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD=lollY.789

Google account: ryan@koalagains.com

When completely finished:
1. Write summary to ${config.resultFile}
2. Run: openclaw system event --text "${options.doneMessage}" --mode now`;
}
