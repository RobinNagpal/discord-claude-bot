import type { Message } from "discord.js";
import { INSIGHTS_UI_MAIN_REPO, INSIGHTS_UI_WORKTREE_BASE, INSIGHTS_UI_WORKTREE_RESULT, INSIGHTS_UI_TASK_RESULT } from "../config.js";
import { runClaude } from "../claude.js";
import { replyInChunks, formatError } from "../discord.js";
import { readResultFile, extractField } from "../result.js";

function buildWorktreeManagementPrompt(taskDescription: string): string {
  return `WORKTREE MANAGEMENT TASK (do NOT write any application code):

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
}

function buildWorktreeTaskPrompt(taskDescription: string, worktreePath: string, branchName: string | null): string {
  const branch = branchName ?? "$(git branch --show-current)";
  return `SAFETY CHECK (do this FIRST, before any code changes):
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
3. Push: git push -u origin ${branch}
4. If no PR exists for this branch, create one: gh pr create --base main --head ${branch} --title "..." --body "..."
5. Write summary to ${INSIGHTS_UI_TASK_RESULT} including:
   - Files changed
   - Branch and commit hash
   - PR URL (or existing PR if already created)
   - Any errors`;
}

function parseWorktreeResult(worktreeInfo: string): { worktreePath: string | null; branchName: string | null } {
  const worktreePath = extractField(worktreeInfo, /worktree\s*path[:\s]*([^\n]+)/i) ?? extractField(worktreeInfo, /selected[:\s]*([^\n]*worktrees\/[^\n\s]+)/i);
  const branchName = extractField(worktreeInfo, /branch[:\s]*(?:name[:\s]*)?([^\n\s]+)/i);
  return { worktreePath, branchName };
}

export async function handleInsightsUI(message: Message, taskDescription: string): Promise<void> {
  await message.reply(`Working on insights-ui task in worktree workflow...\n**Task:** ${taskDescription}`);

  // Step 1: Worktree management
  await message.reply("**Step 1/2:** Managing worktrees...");

  try {
    await runClaude(buildWorktreeManagementPrompt(taskDescription), { cwd: INSIGHTS_UI_MAIN_REPO });
  } catch (err) {
    await message.reply(`Step 1 failed: ${formatError(err)}`);
    return;
  }

  const worktreeInfo = readResultFile(INSIGHTS_UI_WORKTREE_RESULT);
  if (worktreeInfo === "(Could not read result file)") {
    await message.reply("Step 1 failed: could not read worktree result file.");
    return;
  }

  const { worktreePath, branchName } = parseWorktreeResult(worktreeInfo);

  if (!worktreePath) {
    await message.reply(`Step 1 completed but could not determine worktree path.\n\nRaw output:\n${worktreeInfo.slice(0, 1500)}`);
    return;
  }

  await message.reply(`Worktree ready: \`${branchName ?? "unknown"}\` at \`${worktreePath}\`\n**Step 2/2:** Running task in worktree...`);

  // Step 2: Do work in the worktree
  try {
    await runClaude(buildWorktreeTaskPrompt(taskDescription, worktreePath, branchName), { cwd: worktreePath });
  } catch (err) {
    await message.reply(`Step 2 failed: ${formatError(err)}`);
    return;
  }

  const taskResult = readResultFile(INSIGHTS_UI_TASK_RESULT);
  await replyInChunks(message, `**Insights-UI task complete**\n\n${taskResult}`);
}
