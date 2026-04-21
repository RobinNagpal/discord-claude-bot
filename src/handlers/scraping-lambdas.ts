import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Message, type ThreadChannel } from "discord.js";

import {
  SCRAPING_LAMBDAS_MAIN_REPO,
  SCRAPING_LAMBDAS_WORKTREE_BASE,
  SCRAPING_LAMBDAS_WORKTREE_RESULT,
  SCRAPING_LAMBDAS_TASK_RESULT,
  SCRAPING_LAMBDAS_ROUTE_RESULT,
  SCRAPING_LAMBDAS_EXCHANGE_LOG,
  SCRAPING_LAMBDAS_THREAD_LOGS_DIR,
} from "../config.js";
import { runClaude } from "../claude.js";
import { replyInChunks, formatClaudeError } from "../discord.js";
import { readResultFile } from "../result.js";
import { type WorktreeChannelConfig, appendThreadExchange, clearResultFiles, handleWorktreeChannelMessage } from "./worktree-channel.js";

const SUPPORTED_COMMANDS_HELP = `Supported operations:
- **new_task** — describe a coding task to be done in a fresh worktree (e.g. "fix the morningstar-etfs parser", "add retry logic to stockanalysis-stocks"). The bot creates a new worktree + Discord thread and runs the task there.
- **list_worktrees** — list every git worktree in the main repo. No args. Triggered by phrases like "list worktrees", "show worktrees", "what worktrees do we have".
- **delete_worktree** — remove a specific worktree by name. Args: { worktree: "<name>" } where name is the folder name under worktrees/. Triggered by "delete worktree foo", "remove the bar worktree", etc.
- **prune_worktrees** — run \`git worktree prune\` to clean up stale references. No args. Triggered by "prune worktrees", "clean up stale worktrees".
- **list_prs** — list pull requests on the scraping-lambdas repo. Optional arg: { state: "open" | "merged" | "closed" | "all" } (default open). Triggered by "list prs", "show open pull requests", "list merged prs".
- **close_pr** — close a specific pull request. Args: { pr: <number> }. Triggered by "close pr 42", "close pull request #42".
- **maintenance** — free-form fallback for maintenance work that doesn't fit the typed commands above (e.g. "the foo worktree is stuck, investigate and fix"). Args: { instructions: "..." }. The bot will dispatch this to a maintenance Claude in the main repo.`;

const CONFIG: WorktreeChannelConfig = {
  mainRepo: SCRAPING_LAMBDAS_MAIN_REPO,
  worktreeBase: SCRAPING_LAMBDAS_WORKTREE_BASE,
  worktreeResult: SCRAPING_LAMBDAS_WORKTREE_RESULT,
  taskResult: SCRAPING_LAMBDAS_TASK_RESULT,
  routeResult: SCRAPING_LAMBDAS_ROUTE_RESULT,
  exchangeLog: SCRAPING_LAMBDAS_EXCHANGE_LOG,
  threadLogsDir: SCRAPING_LAMBDAS_THREAD_LOGS_DIR,

  startTaskLabel: "scraping-lambdas",
  threadReasonPrefix: "Scraping-Lambdas task:",

  routerProjectDescription: "the scraping-lambdas project",
  supportedCommandsHelp: SUPPORTED_COMMANDS_HELP,

  initialTaskProjectContext:
    "The scraping-lambdas repo is a monorepo with per-lambda subprojects (morningstar-etfs, stockanalysis-etfs, stockanalysis-stocks, stockanalysis-daily-movers). Each subproject has its own package.json. Read CLAUDE.md at the repo root if present; otherwise read the target subproject's README/package.json.",
  initialTaskQualityChecksLine:
    "Run quality checks inside the relevant subproject folder: `yarn compile && yarn prettier-check` (and `yarn lint-fix` if the subproject has that script). Only run against the subproject(s) you actually touched.",
  initialTaskSummaryExample: "Added retry logic to stockanalysis-etfs fetcher.",
};

function buildFollowupPrompt(message: string, worktreePath: string, branchName: string): string {
  return `You are continuing work in the worktree at ${worktreePath} on branch ${branchName}. Your previous session context is loaded via --continue.

SAFETY CHECK: pwd must contain "/worktrees/", current branch must NOT be main/master.

NEW MESSAGE FROM USER: ${message}

Address the new message in the context of the ongoing task. If it's a clarification, update the plan. If it's a follow-up change, make it. If you make code changes, run quality checks in the affected subproject (\`yarn compile && yarn prettier-check\`), commit, push to origin ${branchName}, and update/create the PR.

Write your response to ${SCRAPING_LAMBDAS_TASK_RESULT}. **Two formats depending on what you did:**

**A) If you made code changes (commits, files modified, PR created/updated)** — write a STRICT 2-4 line summary, nothing more:
Line 1: one sentence describing what you changed.
Line 2: Files: <comma-separated short paths>
Line 3: PR: <full PR URL of the current open PR>
Line 4 (optional): blocker / warning.
No markdown headers, no bullet lists, no code blocks, no preamble.

**B) If you only answered a question, investigated, explained, or did not modify any files** — write a full, helpful response. Include code snippets, file references, reasoning, whatever is genuinely useful. No length cap, markdown is fine.

Pick A or B based on whether you actually committed code in this turn. If unsure, default to A.`;
}

export async function handleScrapingLambdas(message: Message, userMessage: string): Promise<void> {
  await handleWorktreeChannelMessage(CONFIG, message, userMessage);
}

export async function handleScrapingLambdasThread(message: Message, thread: ThreadChannel, userMessage: string): Promise<void> {
  const worktreeName = thread.name;
  const worktreePath = join(SCRAPING_LAMBDAS_WORKTREE_BASE, worktreeName);

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
    const errText = formatClaudeError(err, "Follow-up failed");
    appendThreadExchange(CONFIG, worktreeName, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  const result = readResultFile(SCRAPING_LAMBDAS_TASK_RESULT);
  appendThreadExchange(CONFIG, worktreeName, "claude", "ClaudeCode", result);
  await replyInChunks(message, `**Follow-up complete**\n\n${result}`);
}
