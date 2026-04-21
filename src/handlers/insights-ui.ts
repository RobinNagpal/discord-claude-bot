import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Message, type ThreadChannel } from "discord.js";

import {
  INSIGHTS_UI_MAIN_REPO,
  INSIGHTS_UI_WORKTREE_BASE,
  INSIGHTS_UI_WORKTREE_RESULT,
  INSIGHTS_UI_TASK_RESULT,
  INSIGHTS_UI_ROUTE_RESULT,
  INSIGHTS_UI_EXCHANGE_LOG,
  INSIGHTS_UI_THREAD_LOGS_DIR,
} from "../config.js";
import { runClaude } from "../claude.js";
import { replyInChunks, formatError } from "../discord.js";
import { readResultFile } from "../result.js";
import { type WorktreeChannelConfig, appendThreadExchange, clearResultFiles, handleWorktreeChannelMessage } from "./worktree-channel.js";

const SUPPORTED_COMMANDS_HELP = `Supported operations:
- **new_task** — describe a coding task to be done in a fresh worktree (e.g. "fix the broken auth redirect", "add pagination to the ETF listing"). The bot creates a new worktree + Discord thread and runs the task there.
- **list_worktrees** — list every git worktree in the main repo. No args. Triggered by phrases like "list worktrees", "show worktrees", "what worktrees do we have".
- **delete_worktree** — remove a specific worktree by name. Args: { worktree: "<name>" } where name is the folder name under worktrees/. Triggered by "delete worktree etf-pagination", "remove the foo worktree", etc.
- **prune_worktrees** — run \`git worktree prune\` to clean up stale references. No args. Triggered by "prune worktrees", "clean up stale worktrees".
- **list_prs** — list pull requests on the dodao-ui repo. Optional arg: { state: "open" | "merged" | "closed" | "all" } (default open). Triggered by "list prs", "show open pull requests", "list merged prs".
- **close_pr** — close a specific pull request. Args: { pr: <number> }. Triggered by "close pr 1284", "close pull request #1284".
- **maintenance** — free-form fallback for maintenance work that doesn't fit the typed commands above (e.g. "the etf worktree is stuck, investigate and fix"). Args: { instructions: "..." }. The bot will dispatch this to a maintenance Claude in the main repo.`;

const CONFIG: WorktreeChannelConfig = {
  mainRepo: INSIGHTS_UI_MAIN_REPO,
  worktreeBase: INSIGHTS_UI_WORKTREE_BASE,
  worktreeResult: INSIGHTS_UI_WORKTREE_RESULT,
  taskResult: INSIGHTS_UI_TASK_RESULT,
  routeResult: INSIGHTS_UI_ROUTE_RESULT,
  exchangeLog: INSIGHTS_UI_EXCHANGE_LOG,
  threadLogsDir: INSIGHTS_UI_THREAD_LOGS_DIR,

  startTaskLabel: "insights-ui",
  threadReasonPrefix: "Insights-UI task:",

  routerProjectDescription: "the insights-ui (KoalaGains) project",
  supportedCommandsHelp: SUPPORTED_COMMANDS_HELP,

  initialTaskProjectContext: "Read CLAUDE.md at the repo root for full workflow instructions.",
  initialTaskQualityChecksLine: "Run quality checks: yarn lint && yarn prettier-check && yarn compile",
  initialTaskSummaryExample: "Reduced ETF listing page size from 100 to 25.",
};

function buildFollowupPrompt(message: string, worktreePath: string, branchName: string): string {
  return `You are continuing work in the worktree at ${worktreePath} on branch ${branchName}. Your previous session context is loaded via --continue.

SAFETY CHECK: pwd must contain "/worktrees/", current branch must NOT be main/master.

NEW MESSAGE FROM USER: ${message}

Address the new message in the context of the ongoing task. If it's a clarification, update the plan. If it's a follow-up change, make it. If you make code changes, run quality checks (yarn lint && yarn prettier-check && yarn compile), commit, push to origin ${branchName}, and update/create the PR.

Write your response to ${INSIGHTS_UI_TASK_RESULT}. **Two formats depending on what you did:**

**A) If you made code changes (commits, files modified, PR created/updated)** — write a STRICT 2-4 line summary, nothing more:
Line 1: one sentence describing what you changed.
Line 2: Files: <comma-separated short paths>
Line 3: PR: <full PR URL of the current open PR>
Line 4 (optional): blocker / warning.
No markdown headers, no bullet lists, no code blocks, no preamble.

**B) If you only answered a question, investigated, explained, or did not modify any files** — write a full, helpful response. Include code snippets, file references, reasoning, whatever is genuinely useful. No length cap, markdown is fine.

Pick A or B based on whether you actually committed code in this turn. If unsure, default to A.`;
}

export async function handleInsightsUI(message: Message, userMessage: string): Promise<void> {
  await handleWorktreeChannelMessage(CONFIG, message, userMessage);
}

export async function handleInsightsUIThread(message: Message, thread: ThreadChannel, userMessage: string): Promise<void> {
  const worktreeName = thread.name;
  const worktreePath = join(INSIGHTS_UI_WORKTREE_BASE, worktreeName);

  if (!existsSync(worktreePath)) {
    await message.reply(`Worktree \`${worktreePath}\` does not exist. Cannot continue session.`);
    return;
  }

  clearResultFiles(CONFIG);
  appendThreadExchange(CONFIG, worktreeName, "user", message.author.username, userMessage);
  await message.reply("Continuing session...");

  try {
    await runClaude(buildFollowupPrompt(userMessage, worktreePath, worktreeName), { cwd: worktreePath, continueSession: true });
  } catch (err) {
    const errText = `Follow-up failed: ${formatError(err)}`;
    appendThreadExchange(CONFIG, worktreeName, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  const result = readResultFile(INSIGHTS_UI_TASK_RESULT);
  appendThreadExchange(CONFIG, worktreeName, "claude", "ClaudeCode", result);
  await replyInChunks(message, `**Follow-up complete**\n\n${result}`);
}
