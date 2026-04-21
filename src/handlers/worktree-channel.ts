import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChannelType, type Message, type ThreadChannel } from "discord.js";

import { runClaude } from "../claude.js";
import { replyInChunks, sendInChunks, formatError, formatClaudeError } from "../discord.js";
import { readResultFile } from "../result.js";

const execFileAsync = promisify(execFile);

export type RouteDecision =
  | { command: "new_task"; task: string }
  | { command: "list_worktrees" }
  | { command: "delete_worktree"; worktree: string }
  | { command: "prune_worktrees" }
  | { command: "list_prs"; state?: "open" | "merged" | "closed" | "all" }
  | { command: "close_pr"; pr: number }
  | { command: "maintenance"; instructions: string }
  | { command: "unknown"; reason: string };

export interface WorktreeChannelConfig {
  mainRepo: string;
  worktreeBase: string;
  worktreeResult: string;
  taskResult: string;
  routeResult: string;
  exchangeLog: string;
  threadLogsDir: string;

  startTaskLabel: string;
  threadReasonPrefix: string;

  routerProjectDescription: string;
  supportedCommandsHelp: string;

  initialTaskProjectContext: string;
  initialTaskQualityChecksLine: string;
  initialTaskSummaryExample: string;
}

function threadLogPath(config: WorktreeChannelConfig, worktreeName: string): string {
  return join(config.threadLogsDir, `${worktreeName}.md`);
}

export function appendChannelExchange(config: WorktreeChannelConfig, role: "user" | "claude", author: string, content: string): void {
  mkdirSync(dirname(config.exchangeLog), { recursive: true });
  const entry = `\n---\n\n## ${role === "user" ? "User" : "Claude"} — ${author} — ${new Date().toISOString()}\n\n${content.trim()}\n`;
  appendFileSync(config.exchangeLog, entry, "utf-8");
}

export function appendThreadExchange(config: WorktreeChannelConfig, worktreeName: string, role: "user" | "claude", author: string, content: string): void {
  mkdirSync(config.threadLogsDir, { recursive: true });
  const path = threadLogPath(config, worktreeName);
  if (!existsSync(path)) {
    writeFileSync(path, `# Thread: ${worktreeName}\n\nWorktree: ${config.worktreeBase}/${worktreeName}\n`, "utf-8");
  }
  const entry = `\n---\n\n## ${role === "user" ? "User" : "Claude"} — ${author} — ${new Date().toISOString()}\n\n${content.trim()}\n`;
  appendFileSync(path, entry, "utf-8");
}

export function clearResultFiles(config: WorktreeChannelConfig): void {
  for (const path of [config.worktreeResult, config.taskResult, config.routeResult]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

function buildRouterPrompt(config: WorktreeChannelConfig, userMessage: string): string {
  return `You are a strict request router for a Discord bot serving ${config.routerProjectDescription}. You do NOT execute the request — you only classify it and write a JSON decision file.

USER MESSAGE (verbatim, may contain typos / partial sentences):
"""
${userMessage}
"""

${config.supportedCommandsHelp}

Your job:
1. Read the user message and decide which command best matches.
2. Write EXACTLY ONE valid JSON object to ${config.routeResult} — no markdown, no code fences, no commentary, no surrounding text. Just the JSON.

JSON schema (pick exactly ONE of these shapes):

  {"command": "new_task", "task": "<a clean, complete restatement of the coding task in your own words>"}
  {"command": "list_worktrees"}
  {"command": "delete_worktree", "worktree": "<exact folder name under worktrees/>"}
  {"command": "prune_worktrees"}
  {"command": "list_prs", "state": "open" | "merged" | "closed" | "all"}
  {"command": "close_pr", "pr": <integer>}
  {"command": "maintenance", "instructions": "<a clean, complete restatement of the maintenance request that doesn't fit a typed command>"}
  {"command": "unknown", "reason": "<one short sentence explaining why the request doesn't fit any category, or asking a clarifying question>"}

Rules:
- Prefer the most specific typed command. Only use "maintenance" if no typed command fits (e.g. multi-step ops, investigative requests, things that require Claude to reason).
- Use "new_task" only if the user is clearly asking for code/feature work in the project.
- For "delete_worktree": pass through the worktree name as the user said it. The bot will validate and look up the actual folder.
- For "close_pr": extract the PR number as an integer; do not guess if missing — return "unknown" instead.
- For "list_prs" the "state" field is optional; default to "open" if the user didn't specify.
- Use "unknown" for greetings, bot meta-questions, empty/garbled messages, or genuine ambiguity (e.g. bare "list" or "delete" with no object). In "reason", suggest a clarifying example.
- The "task" / "instructions" fields should be clean, self-contained sentences — fix typos and expand abbreviations, but do NOT add scope the user didn't ask for.
- Do NOT actually do the work. Do NOT touch git, files, or PRs. Only write the JSON file and stop.`;
}

function parseRouteDecision(raw: string): RouteDecision | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip code fences if Claude wrapped the JSON despite instructions.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  switch (obj.command) {
    case "new_task":
      if (typeof obj.task === "string" && obj.task.trim()) return { command: "new_task", task: obj.task.trim() };
      return null;
    case "list_worktrees":
      return { command: "list_worktrees" };
    case "delete_worktree":
      if (typeof obj.worktree === "string" && obj.worktree.trim()) return { command: "delete_worktree", worktree: obj.worktree.trim() };
      return null;
    case "prune_worktrees":
      return { command: "prune_worktrees" };
    case "list_prs": {
      const state =
        typeof obj.state === "string" && ["open", "merged", "closed", "all"].includes(obj.state) ? (obj.state as "open" | "merged" | "closed" | "all") : "open";
      return { command: "list_prs", state };
    }
    case "close_pr":
      if (typeof obj.pr === "number" && Number.isInteger(obj.pr) && obj.pr > 0) return { command: "close_pr", pr: obj.pr };
      return null;
    case "maintenance":
      if (typeof obj.instructions === "string" && obj.instructions.trim()) return { command: "maintenance", instructions: obj.instructions.trim() };
      return null;
    case "unknown":
      if (typeof obj.reason === "string" && obj.reason.trim()) return { command: "unknown", reason: obj.reason.trim() };
      return null;
    default:
      return null;
  }
}

async function routeRequest(config: WorktreeChannelConfig, userMessage: string): Promise<RouteDecision | { command: "router_error"; error: string }> {
  try {
    await runClaude(buildRouterPrompt(config, userMessage), { cwd: config.mainRepo });
  } catch (err) {
    return { command: "router_error", error: formatClaudeError(err, "Routing failed") };
  }
  const raw = readResultFile(config.routeResult);
  const parsed = parseRouteDecision(raw);
  if (!parsed) {
    return { command: "router_error", error: `Router output was not valid JSON. Raw:\n${raw.slice(0, 500)}` };
  }
  return parsed;
}

function sanitizeBranchForThread(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 90);
}

function buildWorktreeManagementPrompt(config: WorktreeChannelConfig, taskDescription: string): string {
  return `WORKTREE MANAGEMENT TASK (do NOT write any application code):

0. SAFETY CHECK — Verify main repo is on the main branch:
   Run: git branch --show-current
   If NOT on main: run \`git checkout main\` IMMEDIATELY before anything else.
   If there are uncommitted changes blocking checkout, stash them: \`git stash\`.

1. UPDATE MAIN:
   git pull origin main

2. CREATE — For the task: "${taskDescription}"
   - Pick a short descriptive branch name (kebab-case, no slashes, max 60 chars).
   - Create a new worktree+branch:
     \`git worktree add ${config.worktreeBase}/<branch-name> -b <branch-name> main\`
     The trailing \`main\` ensures the branch starts from main's HEAD.
   - Do NOT remove, prune, or close any existing worktrees, branches, or PRs. Cleanup only happens when the user explicitly asks for it via a maintenance request.

3. VERIFY — Confirm main repo is still on main:
   \`git branch --show-current\` (must output: main)

4. Write result to ${config.worktreeResult}:
   - Selected worktree path
   - Branch name
   - Full output of \`git worktree list\``;
}

function buildMaintenancePrompt(config: WorktreeChannelConfig, taskDescription: string): string {
  return `MAINTENANCE TASK — do NOT create new worktrees or write application code. Only perform maintenance.

Task: "${taskDescription}"

0. SAFETY CHECK — Ensure main repo is on main: \`git branch --show-current\`; if not, \`git checkout main\`.

Typical maintenance operations you may perform:
- List worktrees / branches / PRs
- Remove worktrees whose PRs are merged: \`git worktree remove <path> && git branch -d <branch>\`
- \`git worktree prune\`
- Close PRs via \`gh pr close <number>\`

Write your response to ${config.taskResult}. Maintenance is informational by nature — give a clear, **complete** answer with as much detail as is genuinely useful (full command output, full lists, explanations). No artificial length cap. Markdown is fine. Just make sure the file contains the actual answer, not a summary pointer to it.`;
}

function buildInitialTaskPrompt(config: WorktreeChannelConfig, taskDescription: string, worktreePath: string, branchName: string): string {
  return `You are in a fresh git worktree at ${worktreePath} on branch ${branchName}.

SAFETY CHECK (do this FIRST):
1. Run: pwd — must contain "/worktrees/"
2. Run: git branch --show-current — must NOT be "main" or "master"

TASK: ${taskDescription}

${config.initialTaskProjectContext}

RULES:
- Stay on the current branch. Do NOT switch branches.
- Do NOT run git commands in ${config.mainRepo} (the main repo).

When completely finished with the task:
1. ${config.initialTaskQualityChecksLine}
2. Commit all changes
3. Push: git push -u origin ${branchName}
4. Create a PR if none exists: gh pr create --base main --head ${branchName} --title "..." --body "..."
5. Write your response to ${config.taskResult}. **Two formats depending on what you did:**

   **A) If you made code changes (commits, files modified, PR created)** — write a STRICT 2-4 line summary, exactly these lines, nothing else:
   Line 1: one sentence describing what you changed (e.g., "${config.initialTaskSummaryExample}")
   Line 2: Files: <comma-separated short paths>
   Line 3: PR: <full PR URL of the current open PR>
   Line 4 (optional): any blocker or warning the user needs to know
   No markdown headers, no bullet lists, no code blocks, no preamble. Full details belong in the commit message and PR description, NOT this file.

   **B) If you only investigated, answered a question, or did not modify any files** — write a full, helpful response. Include code snippets, file references, reasoning, whatever is genuinely useful. No length cap, markdown is fine.

   Pick A or B based on whether you actually committed code in this turn. Default to A when in doubt.

If the task is ambiguous or needs clarification, do NOT make up requirements — write a single-line question to ${config.taskResult} instead of committing code.`;
}

function cleanMarkdownValue(val: string): string {
  return val
    .trim()
    .replace(/^[`*_\s]+|[`*_\s]+$/g, "")
    .trim();
}

function parseWorktreeResult(worktreeInfo: string): { worktreePath: string | null; branchName: string | null } {
  const pathMatch =
    worktreeInfo.match(/path[^`\n]*`([^`\n]+)`/i) ?? worktreeInfo.match(/(\/[^\s`]*\/worktrees\/[^\s`]+)/) ?? worktreeInfo.match(/path[:\s]+([^\s`\n]+)/i);
  const branchMatch = worktreeInfo.match(/branch[^`\n]*`([^`\n]+)`/i) ?? worktreeInfo.match(/branch[^:\n]*:\s*([^\s`\n]+)/i);

  const worktreePath = pathMatch ? cleanMarkdownValue(pathMatch[1]) : null;
  const branchName = branchMatch ? cleanMarkdownValue(branchMatch[1]) : null;

  return { worktreePath, branchName };
}

async function runGit(config: WorktreeChannelConfig, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd: config.mainRepo, maxBuffer: 1024 * 1024 });
}

async function runGh(config: WorktreeChannelConfig, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("gh", args, { cwd: config.mainRepo, maxBuffer: 1024 * 1024 });
}

async function handleListWorktrees(config: WorktreeChannelConfig, message: Message): Promise<void> {
  try {
    const { stdout } = await runGit(config, ["worktree", "list"]);
    const reply = `**Worktrees:**\n\`\`\`\n${stdout.trim() || "(none)"}\n\`\`\``;
    appendChannelExchange(config, "claude", "ClaudeCode", reply);
    await replyInChunks(message, reply);
  } catch (err) {
    const errText = `Failed to list worktrees: ${formatError(err)}`;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleDeleteWorktree(config: WorktreeChannelConfig, message: Message, worktreeName: string): Promise<void> {
  const worktreePath = join(config.worktreeBase, worktreeName);
  if (!existsSync(worktreePath)) {
    let availableNote = "";
    try {
      const { stdout } = await runGit(config, ["worktree", "list"]);
      availableNote = `\n\nCurrent worktrees:\n\`\`\`\n${stdout.trim()}\n\`\`\``;
    } catch {
      // ignore
    }
    const errText = `Worktree \`${worktreeName}\` not found at \`${worktreePath}\`.${availableNote}`;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }
  try {
    await runGit(config, ["worktree", "remove", worktreePath, "--force"]);
    let branchMsg = "";
    try {
      await runGit(config, ["branch", "-D", worktreeName]);
      branchMsg = ` and deleted branch \`${worktreeName}\``;
    } catch {
      branchMsg = ` (branch \`${worktreeName}\` was not deleted — may not exist or have a different name)`;
    }
    const reply = `Removed worktree \`${worktreePath}\`${branchMsg}.`;
    appendChannelExchange(config, "claude", "ClaudeCode", reply);
    await message.reply(reply);
  } catch (err) {
    const errText = `Failed to remove worktree \`${worktreeName}\`: ${formatError(err)}`;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handlePruneWorktrees(config: WorktreeChannelConfig, message: Message): Promise<void> {
  try {
    const { stdout, stderr } = await runGit(config, ["worktree", "prune", "--verbose"]);
    const output = `${stdout}${stderr}`.trim() || "(nothing to prune)";
    const reply = `**Pruned stale worktree references:**\n\`\`\`\n${output}\n\`\`\``;
    appendChannelExchange(config, "claude", "ClaudeCode", reply);
    await replyInChunks(message, reply);
  } catch (err) {
    const errText = `Failed to prune worktrees: ${formatError(err)}`;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleListPrs(config: WorktreeChannelConfig, message: Message, state: "open" | "merged" | "closed" | "all"): Promise<void> {
  try {
    const { stdout } = await runGh(config, ["pr", "list", "--state", state, "--limit", "30"]);
    const reply = `**PRs (${state}):**\n\`\`\`\n${stdout.trim() || "(none)"}\n\`\`\``;
    appendChannelExchange(config, "claude", "ClaudeCode", reply);
    await replyInChunks(message, reply);
  } catch (err) {
    const errText = `Failed to list PRs: ${formatError(err)}`;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleClosePr(config: WorktreeChannelConfig, message: Message, pr: number): Promise<void> {
  try {
    const { stdout, stderr } = await runGh(config, ["pr", "close", String(pr)]);
    const output = `${stdout}${stderr}`.trim() || `PR #${pr} closed.`;
    appendChannelExchange(config, "claude", "ClaudeCode", output);
    await message.reply(output);
  } catch (err) {
    const errText = `Failed to close PR #${pr}: ${formatError(err)}`;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleMaintenance(config: WorktreeChannelConfig, message: Message, taskDescription: string): Promise<void> {
  clearResultFiles(config);
  await message.reply(`Running maintenance task...\n**Task:** ${taskDescription}`);
  try {
    await runClaude(buildMaintenancePrompt(config, taskDescription), { cwd: config.mainRepo });
  } catch (err) {
    const errText = formatClaudeError(err, "Maintenance failed");
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }
  const result = readResultFile(config.taskResult);
  appendChannelExchange(config, "claude", "ClaudeCode", result);
  await replyInChunks(message, `**Maintenance complete**\n\n${result}`);
}

async function handleNewTask(config: WorktreeChannelConfig, message: Message, taskDescription: string): Promise<void> {
  clearResultFiles(config);
  await message.reply(`Starting new ${config.startTaskLabel} task...\n**Task:** ${taskDescription}\n\n**Step 1/2:** Managing worktrees...`);

  try {
    await runClaude(buildWorktreeManagementPrompt(config, taskDescription), { cwd: config.mainRepo });
  } catch (err) {
    const errText = formatClaudeError(err, "Step 1 failed");
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  const worktreeInfo = readResultFile(config.worktreeResult);
  const { worktreePath, branchName } = parseWorktreeResult(worktreeInfo);

  if (!worktreePath || !branchName) {
    const errText = `Step 1 completed but could not determine worktree path/branch.\n\nRaw output:\n${worktreeInfo.slice(0, 1500)}`;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  const threadName = sanitizeBranchForThread(branchName);

  const channel = message.channel;
  if (!channel.isTextBased() || channel.isDMBased() || channel.type !== ChannelType.GuildText) {
    await message.reply("Cannot create a thread in this channel type.");
    return;
  }

  let thread: ThreadChannel;
  try {
    thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: `${config.threadReasonPrefix} ${taskDescription.slice(0, 100)}`,
    });
  } catch (err) {
    await message.reply(`Failed to create thread: ${formatError(err)}`);
    return;
  }

  const kickoffMessage = `**Task:** ${taskDescription}\n**Worktree:** \`${worktreePath}\`\n**Branch:** \`${branchName}\`\n\nStarting work — follow up in this thread to continue the conversation.`;
  await thread.send(kickoffMessage);
  appendThreadExchange(config, branchName, "claude", "ClaudeCode", `[thread created]\n\n${kickoffMessage}`);
  appendThreadExchange(config, branchName, "user", message.author.username, taskDescription);
  appendChannelExchange(config, "claude", "ClaudeCode", `Created thread \`${threadName}\` for branch \`${branchName}\``);

  try {
    await runClaude(buildInitialTaskPrompt(config, taskDescription, worktreePath, branchName), { cwd: worktreePath });
  } catch (err) {
    const errText = formatClaudeError(err, "Step 2 failed");
    appendThreadExchange(config, branchName, "claude", "ClaudeCode", errText);
    await thread.send(errText);
    return;
  }

  const taskResult = readResultFile(config.taskResult);
  appendThreadExchange(config, branchName, "claude", "ClaudeCode", taskResult);
  await sendInChunks(thread, `**Task result**\n\n${taskResult}`);
}

export async function handleWorktreeChannelMessage(config: WorktreeChannelConfig, message: Message, userMessage: string): Promise<void> {
  appendChannelExchange(config, "user", message.author.username, userMessage);
  clearResultFiles(config);

  await message.reply("Routing your request...");
  const decision = await routeRequest(config, userMessage);

  if (decision.command === "router_error") {
    const errText = decision.error;
    appendChannelExchange(config, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  appendChannelExchange(config, "claude", "ClaudeCode", `[router] picked command: ${decision.command}`);

  switch (decision.command) {
    case "new_task":
      await handleNewTask(config, message, decision.task);
      return;
    case "list_worktrees":
      await handleListWorktrees(config, message);
      return;
    case "delete_worktree":
      await handleDeleteWorktree(config, message, decision.worktree);
      return;
    case "prune_worktrees":
      await handlePruneWorktrees(config, message);
      return;
    case "list_prs":
      await handleListPrs(config, message, decision.state ?? "open");
      return;
    case "close_pr":
      await handleClosePr(config, message, decision.pr);
      return;
    case "maintenance":
      await handleMaintenance(config, message, decision.instructions);
      return;
    case "unknown": {
      const reply = `Couldn't route your request: ${decision.reason}\n\n${config.supportedCommandsHelp}`;
      appendChannelExchange(config, "claude", "ClaudeCode", reply);
      await replyInChunks(message, reply);
      return;
    }
  }
}
