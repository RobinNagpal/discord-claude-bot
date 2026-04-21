import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChannelType, type Message, type ThreadChannel } from "discord.js";

const execFileAsync = promisify(execFile);
import {
  DISCORD_BOT_MAIN_REPO,
  DISCORD_BOT_WORKTREE_BASE,
  DISCORD_BOT_WORKTREE_RESULT,
  DISCORD_BOT_TASK_RESULT,
  DISCORD_BOT_ROUTE_RESULT,
  DISCORD_BOT_EXCHANGE_LOG,
  DISCORD_BOT_THREAD_LOGS_DIR,
} from "../config.js";
import { runClaude } from "../claude.js";
import { replyInChunks, sendInChunks, formatError, formatClaudeError } from "../discord.js";
import { readResultFile } from "../result.js";

type RouteDecision =
  | { command: "new_task"; task: string }
  | { command: "list_worktrees" }
  | { command: "delete_worktree"; worktree: string }
  | { command: "prune_worktrees" }
  | { command: "list_prs"; state?: "open" | "merged" | "closed" | "all" }
  | { command: "close_pr"; pr: number }
  | { command: "maintenance"; instructions: string }
  | { command: "unknown"; reason: string };

const SUPPORTED_COMMANDS_HELP = `Supported operations:
- **new_task** — describe a coding task to be done in a fresh worktree (e.g. "add a new handler for X channel", "fix the thread naming bug"). The bot creates a new worktree + Discord thread and runs the task there.
- **list_worktrees** — list every git worktree in the main repo. No args. Triggered by phrases like "list worktrees", "show worktrees", "what worktrees do we have".
- **delete_worktree** — remove a specific worktree by name. Args: { worktree: "<name>" } where name is the folder name under worktrees/. Triggered by "delete worktree foo", "remove the bar worktree", etc.
- **prune_worktrees** — run \`git worktree prune\` to clean up stale references. No args. Triggered by "prune worktrees", "clean up stale worktrees".
- **list_prs** — list pull requests on the discord-claude-bot repo. Optional arg: { state: "open" | "merged" | "closed" | "all" } (default open). Triggered by "list prs", "show open pull requests", "list merged prs".
- **close_pr** — close a specific pull request. Args: { pr: <number> }. Triggered by "close pr 42", "close pull request #42".
- **maintenance** — free-form fallback for maintenance work that doesn't fit the typed commands above (e.g. "the foo worktree is stuck, investigate and fix"). Args: { instructions: "..." }. The bot will dispatch this to a maintenance Claude in the main repo.`;

function threadLogPath(worktreeName: string): string {
  return join(DISCORD_BOT_THREAD_LOGS_DIR, `${worktreeName}.md`);
}

function appendChannelExchange(role: "user" | "claude", author: string, content: string): void {
  mkdirSync(dirname(DISCORD_BOT_EXCHANGE_LOG), { recursive: true });
  const entry = `\n---\n\n## ${role === "user" ? "User" : "Claude"} — ${author} — ${new Date().toISOString()}\n\n${content.trim()}\n`;
  appendFileSync(DISCORD_BOT_EXCHANGE_LOG, entry, "utf-8");
}

function appendThreadExchange(worktreeName: string, role: "user" | "claude", author: string, content: string): void {
  mkdirSync(DISCORD_BOT_THREAD_LOGS_DIR, { recursive: true });
  const path = threadLogPath(worktreeName);
  if (!existsSync(path)) {
    writeFileSync(path, `# Thread: ${worktreeName}\n\nWorktree: ${DISCORD_BOT_WORKTREE_BASE}/${worktreeName}\n`, "utf-8");
  }
  const entry = `\n---\n\n## ${role === "user" ? "User" : "Claude"} — ${author} — ${new Date().toISOString()}\n\n${content.trim()}\n`;
  appendFileSync(path, entry, "utf-8");
}

function clearResultFiles(): void {
  for (const path of [DISCORD_BOT_WORKTREE_RESULT, DISCORD_BOT_TASK_RESULT, DISCORD_BOT_ROUTE_RESULT]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

function buildRouterPrompt(userMessage: string): string {
  return `You are a strict request router for a Discord bot serving the discord-claude-bot project (the bot's own codebase). You do NOT execute the request — you only classify it and write a JSON decision file.

USER MESSAGE (verbatim, may contain typos / partial sentences):
"""
${userMessage}
"""

${SUPPORTED_COMMANDS_HELP}

Your job:
1. Read the user message and decide which command best matches.
2. Write EXACTLY ONE valid JSON object to ${DISCORD_BOT_ROUTE_RESULT} — no markdown, no code fences, no commentary, no surrounding text. Just the JSON.

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

async function routeRequest(userMessage: string): Promise<RouteDecision | { command: "router_error"; error: string }> {
  try {
    await runClaude(buildRouterPrompt(userMessage), { cwd: DISCORD_BOT_MAIN_REPO });
  } catch (err) {
    return { command: "router_error", error: formatClaudeError(err, "Routing failed") };
  }
  const raw = readResultFile(DISCORD_BOT_ROUTE_RESULT);
  const parsed = parseRouteDecision(raw);
  if (!parsed) {
    return { command: "router_error", error: `Router output was not valid JSON. Raw:\n${raw.slice(0, 500)}` };
  }
  return parsed;
}

function sanitizeBranchForThread(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 90);
}

function buildWorktreeManagementPrompt(taskDescription: string): string {
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
     \`git worktree add ${DISCORD_BOT_WORKTREE_BASE}/<branch-name> -b <branch-name> main\`
     The trailing \`main\` ensures the branch starts from main's HEAD.
   - Do NOT remove, prune, or close any existing worktrees, branches, or PRs. Cleanup only happens when the user explicitly asks for it via a maintenance request.

3. VERIFY — Confirm main repo is still on main:
   \`git branch --show-current\` (must output: main)

4. Write result to ${DISCORD_BOT_WORKTREE_RESULT}:
   - Selected worktree path
   - Branch name
   - Full output of \`git worktree list\``;
}

function buildMaintenancePrompt(taskDescription: string): string {
  return `MAINTENANCE TASK — do NOT create new worktrees or write application code. Only perform maintenance.

Task: "${taskDescription}"

0. SAFETY CHECK — Ensure main repo is on main: \`git branch --show-current\`; if not, \`git checkout main\`.

Typical maintenance operations you may perform:
- List worktrees / branches / PRs
- Remove worktrees whose PRs are merged: \`git worktree remove <path> && git branch -d <branch>\`
- \`git worktree prune\`
- Close PRs via \`gh pr close <number>\`

Write your response to ${DISCORD_BOT_TASK_RESULT}. Maintenance is informational by nature — give a clear, **complete** answer with as much detail as is genuinely useful (full command output, full lists, explanations). No artificial length cap. Markdown is fine. Just make sure the file contains the actual answer, not a summary pointer to it.`;
}

function buildInitialTaskPrompt(taskDescription: string, worktreePath: string, branchName: string): string {
  return `You are in a fresh git worktree at ${worktreePath} on branch ${branchName}.

SAFETY CHECK (do this FIRST):
1. Run: pwd — must contain "/worktrees/"
2. Run: git branch --show-current — must NOT be "main" or "master"

TASK: ${taskDescription}

This is the discord-claude-bot project — a TypeScript Discord bot built with discord.js, ESLint, and Prettier. Read CLAUDE.md at the repo root for full project context, build commands, and architecture details.

RULES:
- Stay on the current branch. Do NOT switch branches.
- Do NOT run git commands in ${DISCORD_BOT_MAIN_REPO} (the main repo).

When completely finished with the task:
1. Run quality checks: \`npm run typecheck && npm run lint && npm run prettier\`
2. Commit all changes
3. Push: git push -u origin ${branchName}
4. Create a PR if none exists: gh pr create --base main --head ${branchName} --title "..." --body "..."
5. Write your response to ${DISCORD_BOT_TASK_RESULT}. **Two formats depending on what you did:**

   **A) If you made code changes (commits, files modified, PR created)** — write a STRICT 2-4 line summary, exactly these lines, nothing else:
   Line 1: one sentence describing what you changed (e.g., "Added new channel handler for X project.")
   Line 2: Files: <comma-separated short paths>
   Line 3: PR: <full PR URL of the current open PR>
   Line 4 (optional): any blocker or warning the user needs to know
   No markdown headers, no bullet lists, no code blocks, no preamble. Full details belong in the commit message and PR description, NOT this file.

   **B) If you only investigated, answered a question, or did not modify any files** — write a full, helpful response. Include code snippets, file references, reasoning, whatever is genuinely useful. No length cap, markdown is fine.

   Pick A or B based on whether you actually committed code in this turn. Default to A when in doubt.

If the task is ambiguous or needs clarification, do NOT make up requirements — write a single-line question to ${DISCORD_BOT_TASK_RESULT} instead of committing code.`;
}

function buildFollowupPrompt(message: string, worktreePath: string, branchName: string): string {
  return `You are continuing work in the worktree at ${worktreePath} on branch ${branchName}. Your previous session context is loaded via --continue.

SAFETY CHECK: pwd must contain "/worktrees/", current branch must NOT be main/master.

NEW MESSAGE FROM USER: ${message}

Address the new message in the context of the ongoing task. If it's a clarification, update the plan. If it's a follow-up change, make it. If you make code changes, run quality checks (\`npm run typecheck && npm run lint && npm run prettier\`), commit, push to origin ${branchName}, and update/create the PR.

Write your response to ${DISCORD_BOT_TASK_RESULT}. **Two formats depending on what you did:**

**A) If you made code changes (commits, files modified, PR created/updated)** — write a STRICT 2-4 line summary, nothing more:
Line 1: one sentence describing what you changed.
Line 2: Files: <comma-separated short paths>
Line 3: PR: <full PR URL of the current open PR>
Line 4 (optional): blocker / warning.
No markdown headers, no bullet lists, no code blocks, no preamble.

**B) If you only answered a question, investigated, explained, or did not modify any files** — write a full, helpful response. Include code snippets, file references, reasoning, whatever is genuinely useful. No length cap, markdown is fine.

Pick A or B based on whether you actually committed code in this turn. If unsure, default to A.`;
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

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd: DISCORD_BOT_MAIN_REPO, maxBuffer: 1024 * 1024 });
}

async function runGh(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("gh", args, { cwd: DISCORD_BOT_MAIN_REPO, maxBuffer: 1024 * 1024 });
}

async function handleListWorktrees(message: Message): Promise<void> {
  try {
    const { stdout } = await runGit(["worktree", "list"]);
    const reply = `**Worktrees:**\n\`\`\`\n${stdout.trim() || "(none)"}\n\`\`\``;
    appendChannelExchange("claude", "ClaudeCode", reply);
    await replyInChunks(message, reply);
  } catch (err) {
    const errText = `Failed to list worktrees: ${formatError(err)}`;
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleDeleteWorktree(message: Message, worktreeName: string): Promise<void> {
  const worktreePath = join(DISCORD_BOT_WORKTREE_BASE, worktreeName);
  if (!existsSync(worktreePath)) {
    let availableNote = "";
    try {
      const { stdout } = await runGit(["worktree", "list"]);
      availableNote = `\n\nCurrent worktrees:\n\`\`\`\n${stdout.trim()}\n\`\`\``;
    } catch {
      // ignore
    }
    const errText = `Worktree \`${worktreeName}\` not found at \`${worktreePath}\`.${availableNote}`;
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }
  try {
    await runGit(["worktree", "remove", worktreePath, "--force"]);
    let branchMsg = "";
    try {
      await runGit(["branch", "-D", worktreeName]);
      branchMsg = ` and deleted branch \`${worktreeName}\``;
    } catch {
      branchMsg = ` (branch \`${worktreeName}\` was not deleted — may not exist or have a different name)`;
    }
    const reply = `Removed worktree \`${worktreePath}\`${branchMsg}.`;
    appendChannelExchange("claude", "ClaudeCode", reply);
    await message.reply(reply);
  } catch (err) {
    const errText = `Failed to remove worktree \`${worktreeName}\`: ${formatError(err)}`;
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handlePruneWorktrees(message: Message): Promise<void> {
  try {
    const { stdout, stderr } = await runGit(["worktree", "prune", "--verbose"]);
    const output = `${stdout}${stderr}`.trim() || "(nothing to prune)";
    const reply = `**Pruned stale worktree references:**\n\`\`\`\n${output}\n\`\`\``;
    appendChannelExchange("claude", "ClaudeCode", reply);
    await replyInChunks(message, reply);
  } catch (err) {
    const errText = `Failed to prune worktrees: ${formatError(err)}`;
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleListPrs(message: Message, state: "open" | "merged" | "closed" | "all"): Promise<void> {
  try {
    const { stdout } = await runGh(["pr", "list", "--state", state, "--limit", "30"]);
    const reply = `**PRs (${state}):**\n\`\`\`\n${stdout.trim() || "(none)"}\n\`\`\``;
    appendChannelExchange("claude", "ClaudeCode", reply);
    await replyInChunks(message, reply);
  } catch (err) {
    const errText = `Failed to list PRs: ${formatError(err)}`;
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleClosePr(message: Message, pr: number): Promise<void> {
  try {
    const { stdout, stderr } = await runGh(["pr", "close", String(pr)]);
    const output = `${stdout}${stderr}`.trim() || `PR #${pr} closed.`;
    appendChannelExchange("claude", "ClaudeCode", output);
    await message.reply(output);
  } catch (err) {
    const errText = `Failed to close PR #${pr}: ${formatError(err)}`;
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
  }
}

async function handleMaintenance(message: Message, taskDescription: string): Promise<void> {
  clearResultFiles();
  await message.reply(`Running maintenance task...\n**Task:** ${taskDescription}`);
  try {
    await runClaude(buildMaintenancePrompt(taskDescription), { cwd: DISCORD_BOT_MAIN_REPO });
  } catch (err) {
    const errText = formatClaudeError(err, "Maintenance failed");
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }
  const result = readResultFile(DISCORD_BOT_TASK_RESULT);
  appendChannelExchange("claude", "ClaudeCode", result);
  await replyInChunks(message, `**Maintenance complete**\n\n${result}`);
}

async function handleNewTask(message: Message, taskDescription: string): Promise<void> {
  clearResultFiles();
  await message.reply(`Starting new discord-claude-bot task...\n**Task:** ${taskDescription}\n\n**Step 1/2:** Managing worktrees...`);

  try {
    await runClaude(buildWorktreeManagementPrompt(taskDescription), { cwd: DISCORD_BOT_MAIN_REPO });
  } catch (err) {
    const errText = formatClaudeError(err, "Step 1 failed");
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  const worktreeInfo = readResultFile(DISCORD_BOT_WORKTREE_RESULT);
  const { worktreePath, branchName } = parseWorktreeResult(worktreeInfo);

  if (!worktreePath || !branchName) {
    const errText = `Step 1 completed but could not determine worktree path/branch.\n\nRaw output:\n${worktreeInfo.slice(0, 1500)}`;
    appendChannelExchange("claude", "ClaudeCode", errText);
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
      reason: `Discord-Bot task: ${taskDescription.slice(0, 100)}`,
    });
  } catch (err) {
    await message.reply(`Failed to create thread: ${formatError(err)}`);
    return;
  }

  const kickoffMessage = `**Task:** ${taskDescription}\n**Worktree:** \`${worktreePath}\`\n**Branch:** \`${branchName}\`\n\nStarting work — follow up in this thread to continue the conversation.`;
  await thread.send(kickoffMessage);
  appendThreadExchange(branchName, "claude", "ClaudeCode", `[thread created]\n\n${kickoffMessage}`);
  appendThreadExchange(branchName, "user", message.author.username, taskDescription);
  appendChannelExchange("claude", "ClaudeCode", `Created thread \`${threadName}\` for branch \`${branchName}\``);

  try {
    await runClaude(buildInitialTaskPrompt(taskDescription, worktreePath, branchName), { cwd: worktreePath });
  } catch (err) {
    const errText = formatClaudeError(err, "Step 2 failed");
    appendThreadExchange(branchName, "claude", "ClaudeCode", errText);
    await thread.send(errText);
    return;
  }

  const taskResult = readResultFile(DISCORD_BOT_TASK_RESULT);
  appendThreadExchange(branchName, "claude", "ClaudeCode", taskResult);
  await sendInChunks(thread, `**Task result**\n\n${taskResult}`);
}

export async function handleDiscordBot(message: Message, userMessage: string): Promise<void> {
  appendChannelExchange("user", message.author.username, userMessage);
  clearResultFiles();

  await message.reply("Routing your request...");
  const decision = await routeRequest(userMessage);

  if (decision.command === "router_error") {
    const errText = decision.error;
    appendChannelExchange("claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  appendChannelExchange("claude", "ClaudeCode", `[router] picked command: ${decision.command}`);

  switch (decision.command) {
    case "new_task":
      await handleNewTask(message, decision.task);
      return;
    case "list_worktrees":
      await handleListWorktrees(message);
      return;
    case "delete_worktree":
      await handleDeleteWorktree(message, decision.worktree);
      return;
    case "prune_worktrees":
      await handlePruneWorktrees(message);
      return;
    case "list_prs":
      await handleListPrs(message, decision.state ?? "open");
      return;
    case "close_pr":
      await handleClosePr(message, decision.pr);
      return;
    case "maintenance":
      await handleMaintenance(message, decision.instructions);
      return;
    case "unknown": {
      const reply = `Couldn't route your request: ${decision.reason}\n\n${SUPPORTED_COMMANDS_HELP}`;
      appendChannelExchange("claude", "ClaudeCode", reply);
      await replyInChunks(message, reply);
      return;
    }
  }
}

export async function handleDiscordBotThread(message: Message, thread: ThreadChannel, userMessage: string): Promise<void> {
  const worktreeName = thread.name;
  const worktreePath = join(DISCORD_BOT_WORKTREE_BASE, worktreeName);

  if (!existsSync(worktreePath)) {
    await message.reply(`Worktree \`${worktreePath}\` does not exist. Cannot continue session.`);
    return;
  }

  clearResultFiles();
  appendThreadExchange(worktreeName, "user", message.author.username, userMessage);
  await message.reply("Continuing session...");

  try {
    await runClaude(buildFollowupPrompt(userMessage, worktreePath, worktreeName), { cwd: worktreePath, continueSession: true });
  } catch (err) {
    const errText = formatClaudeError(err, "Follow-up failed");
    appendThreadExchange(worktreeName, "claude", "ClaudeCode", errText);
    await message.reply(errText);
    return;
  }

  const result = readResultFile(DISCORD_BOT_TASK_RESULT);
  appendThreadExchange(worktreeName, "claude", "ClaudeCode", result);
  await replyInChunks(message, `**Follow-up complete**\n\n${result}`);
}
