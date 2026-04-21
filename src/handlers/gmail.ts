import type { Message } from "discord.js";
import { GMAIL_WORKSPACE, GMAIL_RESULT } from "../config.js";
import { runClaude } from "../claude.js";
import { replyInChunks, formatClaudeError } from "../discord.js";
import { readResultFile } from "../result.js";

function detectWorkflow(taskDescription: string): string {
  const taskLower = taskDescription.toLowerCase();

  if (taskLower.includes("send") && (taskLower.includes("follow") || taskLower.includes("email"))) {
    return `Read workflows/send_follow_up.md for the complete workflow steps.
Gmail account for sending: ryan@koalagains.com`;
  }

  if (taskLower.includes("export") || taskLower.includes("csv")) {
    return `Read workflows/export_follow_up.md for the complete workflow steps.
Gmail account for this workflow: zain@koalagains.com`;
  }

  if (taskLower.includes("process") || taskLower.includes("label") || taskLower.includes("follow")) {
    return `Read workflows/amb_prgm_follow_up.md for the complete workflow steps.
Gmail account for this workflow: zain@koalagains.com`;
  }

  return `Check /home/ubuntu/.openclaw/workspace-gmail/workflows/ to identify the relevant workflow.
Available workflows:
- workflows/amb_prgm_follow_up.md (process & label ambassador threads)
- workflows/export_follow_up.md (export follow-up threads to CSV)
- workflows/send_follow_up.md (send follow-up emails from CSV)`;
}

function buildGmailPrompt(taskDescription: string, workflowContext: string): string {
  return `You are handling a Gmail workflow task. Read the CLAUDE.md in the current directory for full context.

TASK: ${taskDescription}

${workflowContext}

Follow ALL steps and rules in the workflow file exactly.

Environment setup (required for all gog commands):
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD=lollY.789

RULES:
- Every Gmail command MUST include --account (zain@koalagains.com for processing, ryan@koalagains.com for sending)
- Do NOT use time filters (newer_than, etc.)
- Label operations at THREAD level only
- CSV must append rows, never overwrite
- Do NOT remove CSV rows unless email send succeeded

When completely finished:
1. Write summary to ${GMAIL_RESULT}
2. Run: openclaw system event --text "Done: [brief summary]" --mode now`;
}

export async function handleGmail(message: Message, taskDescription: string): Promise<void> {
  await message.reply(`Working on Gmail task...\n**Task:** ${taskDescription}`);

  const workflowContext = detectWorkflow(taskDescription);
  const prompt = buildGmailPrompt(taskDescription, workflowContext);

  try {
    await runClaude(prompt, { cwd: GMAIL_WORKSPACE });
  } catch (err) {
    await message.reply(formatClaudeError(err, "Task failed"));
    return;
  }

  const taskResult = readResultFile(GMAIL_RESULT);
  await replyInChunks(message, `**Gmail task complete**\n\n${taskResult}`);
}
