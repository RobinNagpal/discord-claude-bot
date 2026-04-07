import type { Message } from "discord.js";
import { OUTREACH_DATA_WORKSPACE, OUTREACH_DATA_RESULT } from "../config.js";
import { runClaude } from "../claude.js";
import { replyInChunks, formatError } from "../discord.js";
import { readResultFile } from "../result.js";

function detectCampaignContext(taskDescription: string): string {
  const taskLower = taskDescription.toLowerCase();

  if (taskLower.includes("amb") || taskLower.includes("ambassador") || taskLower.includes("placement")) {
    return `Read the campaign files at: ${OUTREACH_DATA_WORKSPACE}/campaigns/amb-prgm/
Check campaign-info.md for lead generation, write-emails.md for composing, send-emails.md for sending, followup-1.md and followup-2.md for followups.`;
  }

  if (taskLower.includes("e-degree") || taskLower.includes("edegree") || taskLower.includes("university") || taskLower.includes("mba")) {
    return `Read the campaign file at: ${OUTREACH_DATA_WORKSPACE}/campaigns/e-degree.md`;
  }

  return `Check ${OUTREACH_DATA_WORKSPACE}/campaigns/ to identify the relevant campaign.
Available campaigns:
- campaigns/e-degree.md (university e-degree program outreach)
- campaigns/amb-prgm/ (ambassador program / placement offices)`;
}

function buildOutreachPrompt(taskDescription: string, campaignContext: string): string {
  return `You are handling an outreach data task. Read the CLAUDE.md in the current directory for full context.

TASK: ${taskDescription}

${campaignContext}

Campaign assets (Python scripts) are in: ${OUTREACH_DATA_WORKSPACE}/campaign_assets/
Cron task definitions are in: ${OUTREACH_DATA_WORKSPACE}/cron-tasks/

Environment setup (required for all gog commands):
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD=lollY.789

Google account: ryan@koalagains.com
Sheet ID: 1Kmg1f0iJbWIv5oWFXQJmxFHVRTO9EKC67SuPDiTcOcc

CRITICAL RULES:
- ONE email per send invocation — never loop or batch
- Run find-eligible scripts exactly ONCE per invocation
- Never guess/invent emails or phone numbers — leave empty if not found
- Use pipe | separator for values without commas, --values-json for values with commas
- Format email body as single-line HTML — no literal newlines, use <br>
- No <p> tags — only <br> and <a> tags
- Always use --force flag with gog gmail send
- Vary email wording across sends

When completely finished:
1. Write summary to ${OUTREACH_DATA_RESULT} including: records found, records added/sent, errors
2. Run: openclaw system event --text "Done: [brief summary]" --mode now`;
}

export async function handleOutreachData(message: Message, taskDescription: string): Promise<void> {
  await message.reply(`Working on outreach-data task...\n**Task:** ${taskDescription}`);

  const campaignContext = detectCampaignContext(taskDescription);
  const prompt = buildOutreachPrompt(taskDescription, campaignContext);

  try {
    await runClaude(prompt, { cwd: OUTREACH_DATA_WORKSPACE });
  } catch (err) {
    await message.reply(`Task failed: ${formatError(err)}`);
    return;
  }

  const taskResult = readResultFile(OUTREACH_DATA_RESULT);
  await replyInChunks(message, `**Outreach-data task complete**\n\n${taskResult}`);
}
