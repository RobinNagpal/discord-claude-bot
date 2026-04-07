import "dotenv/config";
import { Client, GatewayIntentBits, Message } from "discord.js";
import { execFile } from "child_process";
import fs from "fs";

// --- Config from .env ---
const DISCORD_TOKEN: string = process.env.DISCORD_TOKEN ?? "";
const PREFIX: string = process.env.PREFIX ?? "!claude";
const ALLOWED_CHANNELS: string[] | null = parseList(process.env.ALLOWED_CHANNELS);
const ALLOWED_USERS: string[] | null = parseList(process.env.ALLOWED_USERS);
const MAX_CONCURRENT: number = parseInt(process.env.MAX_CONCURRENT ?? "3", 10);
const CLAUDE_TIMEOUT: number = parseInt(process.env.CLAUDE_TIMEOUT ?? "300000", 10);
const MAX_BUFFER: number = parseInt(process.env.MAX_BUFFER ?? "1048576", 10);
const MAX_DISCORD_LENGTH = 1900;

// --- Insights-UI channel routing ---
const INSIGHTS_UI_CHANNEL: string = process.env.INSIGHTS_UI_CHANNEL ?? "1491102767224324309";
const INSIGHTS_UI_MAIN_REPO: string = process.env.INSIGHTS_UI_MAIN_REPO ?? "/home/ubuntu/.openclaw/workspace-insights-ui/dodao-ui";
const INSIGHTS_UI_WORKTREE_BASE: string = process.env.INSIGHTS_UI_WORKTREE_BASE ?? "/home/ubuntu/.openclaw/workspace-insights-ui/worktrees";
const INSIGHTS_UI_WORKTREE_RESULT = "/tmp/claude-code-worktree-insights.md";
const INSIGHTS_UI_TASK_RESULT = "/tmp/claude-code-result-insights.md";

function parseList(val: string | undefined): string[] | null {
  if (!val?.trim()) return null;
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Startup validation ---
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required. Set it in .env or as an environment variable.");
  process.exit(1);
}

// --- Concurrency tracking ---
let activeJobs = 0;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown"}`);
});

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  // Match prefix with or without trailing content
  if (!message.content.startsWith(PREFIX)) return;

  const afterPrefix = message.content.slice(PREFIX.length);

  // Reject if prefix is followed by non-space characters (e.g. "!claudeX")
  if (afterPrefix.length > 0 && afterPrefix[0] !== " ") return;

  const prompt = afterPrefix.trim();

  // --- Channel restriction ---
  if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(message.channelId)) return;

  // --- User restriction ---
  if (ALLOWED_USERS && !ALLOWED_USERS.includes(message.author.id)) {
    await message.reply("You are not authorized to use this bot.");
    return;
  }

  if (!prompt) {
    await message.reply(`Please provide a prompt after \`${PREFIX}\`.`);
    return;
  }

  // --- Concurrency limit ---
  if (activeJobs >= MAX_CONCURRENT) {
    await message.reply("Too many requests in progress. Please wait and try again.");
    return;
  }

  activeJobs++;

  try {
    if (message.channelId === INSIGHTS_UI_CHANNEL) {
      await handleInsightsUI(message, prompt);
    } else {
      await handleGeneral(message, prompt);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await message.reply(`Error: ${errMsg.slice(0, 500)}`);
  } finally {
    activeJobs--;
  }
});

// --- General handler (default) ---
async function handleGeneral(message: Message, prompt: string): Promise<void> {
  await message.reply("Working on it...");
  const output = await runClaude(prompt);
  for (const chunk of splitMessage(output)) {
    await message.reply(chunk);
  }
}

// --- Insights-UI handler (two-step worktree workflow) ---
async function handleInsightsUI(message: Message, taskDescription: string): Promise<void> {
  await message.reply(`Working on insights-ui task in worktree workflow...\n**Task:** ${taskDescription}`);

  // Step 1: Worktree management (run in main repo)
  await message.reply("**Step 1/2:** Managing worktrees...");

  const step1Prompt = `WORKTREE MANAGEMENT TASK (do NOT write any application code):

0. SAFETY CHECK — Verify main repo is on the main branch:
   Run: git branch --show-current
   If NOT on main: run \`git checkout main\` IMMEDIATELY before anything else.
   If there are uncommitted changes blocking checkout, stash them: \`git stash\`.

1. UPDATE MAIN:
   git pull origin main

2. CLEANUP — Run \`git worktree list\`. For each worktree (skip the main repo line):
   - Extract its branch name.
   - Check if branch has a merged PR: \`gh pr list --head <branch> --state merged --json number\`
   - If PR is merged: \`git worktree remove <path> && git branch -d <branch>\`
   - Also run \`git worktree prune\` to clean stale references.
   - Report what was cleaned.

3. SELECT OR CREATE — For the task: "${taskDescription}"
   - Run \`git worktree list\` to see current worktrees.
   - Only reuse an existing worktree if the task is explicitly a CONTINUATION of that work.
   - For any NEW task, ALWAYS create a new worktree+branch:
     \`git worktree add ${INSIGHTS_UI_WORKTREE_BASE}/<branch-name> -b <branch-name> main\`
     The trailing \`main\` ensures the branch starts from main's HEAD. ALWAYS include it.
   - Pick a short descriptive branch name.

4. VERIFY — Confirm main repo is still on main:
   \`git branch --show-current\` (must output: main)

5. Write result to ${INSIGHTS_UI_WORKTREE_RESULT}:
   - Cleaned worktrees (if any)
   - Selected worktree path
   - Branch name
   - Whether it is new or existing
   - Full output of \`git worktree list\``;

  try {
    await runClaude(step1Prompt, INSIGHTS_UI_MAIN_REPO);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await message.reply(`Step 1 failed: ${errMsg.slice(0, 500)}`);
    return;
  }

  // Read worktree result
  let worktreeInfo: string;
  try {
    worktreeInfo = fs.readFileSync(INSIGHTS_UI_WORKTREE_RESULT, "utf-8");
  } catch {
    await message.reply("Step 1 failed: could not read worktree result file.");
    return;
  }

  const worktreePath = extractField(worktreeInfo, /worktree\s*path[:\s]*([^\n]+)/i) ?? extractField(worktreeInfo, /selected[:\s]*([^\n]*worktrees\/[^\n\s]+)/i);
  const branchName = extractField(worktreeInfo, /branch[:\s]*(?:name[:\s]*)?([^\n\s]+)/i);

  if (!worktreePath) {
    await message.reply(`Step 1 completed but could not determine worktree path.\n\nRaw output:\n${worktreeInfo.slice(0, 1500)}`);
    return;
  }

  await message.reply(`Worktree ready: \`${branchName ?? "unknown"}\` at \`${worktreePath}\`\n**Step 2/2:** Running task in worktree...`);

  // Step 2: Do work in the worktree
  const step2Prompt = `SAFETY CHECK (do this FIRST, before any code changes):
1. Run: pwd
   - Your working directory MUST contain "/worktrees/" in the path.
   - If it does NOT, STOP IMMEDIATELY. Write "ERROR: Not in a worktree" to ${INSIGHTS_UI_TASK_RESULT} and exit.
2. Run: git branch --show-current
   - Must NOT be "main" or "master". If it is, STOP with same error as above.

TASK: ${taskDescription}

Worktree: ${worktreePath}
Branch: ${branchName ?? "see git branch --show-current"}

Read CLAUDE.md at the repo root for full workflow instructions.

RULES:
- Do NOT switch branches. Stay on the current branch.
- Do NOT run git commands in ${INSIGHTS_UI_MAIN_REPO} (the main repo). Only work in this worktree.

When completely finished:
1. Run quality checks: yarn lint && yarn prettier-check && yarn build
2. Commit all changes
3. Push: git push -u origin ${branchName ?? "$(git branch --show-current)"}
4. If no PR exists for this branch, create one: gh pr create --base main --head ${branchName ?? "$(git branch --show-current)"} --title "..." --body "..."
5. Write summary to ${INSIGHTS_UI_TASK_RESULT} including:
   - Files changed
   - Branch and commit hash
   - PR URL (or existing PR if already created)
   - Any errors`;

  try {
    await runClaude(step2Prompt, worktreePath);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await message.reply(`Step 2 failed: ${errMsg.slice(0, 500)}`);
    return;
  }

  // Read task result
  let taskResult: string;
  try {
    taskResult = fs.readFileSync(INSIGHTS_UI_TASK_RESULT, "utf-8");
  } catch {
    taskResult = "(Could not read result file)";
  }

  for (const chunk of splitMessage(`**Insights-UI task complete**\n\n${taskResult}`)) {
    await message.reply(chunk);
  }
}

function extractField(text: string, regex: RegExp): string | null {
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function runClaude(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--dangerously-skip-permissions", "--output-format", "text", prompt];
    const opts: { timeout: number; maxBuffer: number; cwd?: string } = { timeout: CLAUDE_TIMEOUT, maxBuffer: MAX_BUFFER };
    if (cwd) opts.cwd = cwd;

    execFile("claude", args, opts, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim() || "(no output)");
      }
    });
  });
}

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = MAX_DISCORD_LENGTH;

    const lastNewline = remaining.lastIndexOf("\n", splitAt);
    if (lastNewline > splitAt * 0.5) {
      splitAt = lastNewline + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(" ", splitAt);
      if (lastSpace > splitAt * 0.5) {
        splitAt = lastSpace + 1;
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

client.login(DISCORD_TOKEN);
