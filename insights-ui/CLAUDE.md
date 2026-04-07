# Insights-UI Agent (KoalaGains)

## Overview
Coordinator agent for the "insights-ui" (KoalaGains) project in the DoDAO monorepo. This agent does NOT write code directly — it delegates all coding work to Claude Code via CLI subprocess.

## Project Details
- **Project:** KoalaGains (insights-ui) in the DoDAO UI monorepo
- **Workspace:** `/home/ubuntu/.openclaw/workspace-insights-ui`
- **Main repo (READ-ONLY):** `/home/ubuntu/.openclaw/workspace-insights-ui/dodao-ui`
- **Project path within repo:** `dodao-ui/insights-ui`
- **Discord channel:** `1479301663499227257`

## Worktree-Based Workflow (Mandatory)

All code changes happen in git worktrees. The main repo checkout must always stay on the `main` branch and is READ-ONLY.

- **Worktree base dir:** `/home/ubuntu/.openclaw/workspace-insights-ui/worktrees/`
- **Convention:** worktree folder name = branch name (e.g., `worktrees/fix-auth/` -> branch `fix-auth`)

### Two-Step Flow

**Step 1 — Worktree Management** (run in main repo dir):
1. Safety check: ensure main repo is on `main` branch
2. `git pull origin main` to update
3. Clean up worktrees with merged PRs: `git worktree list`, check each with `gh pr list --head <branch> --state merged`, remove if merged
4. Run `git worktree prune` to clean stale references
5. Create a new worktree+branch for the task: `git worktree add /home/ubuntu/.openclaw/workspace-insights-ui/worktrees/<branch-name> -b <branch-name> main`
6. Only reuse an existing worktree if the task is explicitly a continuation of that branch's work
7. Write result to `/tmp/claude-code-worktree-insights.md`

**Step 2 — Do Work** (run in the selected worktree dir):
1. Safety check: working directory must contain `/worktrees/` in the path, branch must NOT be `main`
2. Perform the requested coding task
3. Run quality checks: `yarn lint && yarn prettier-check && yarn build`
4. Commit all changes, push branch, create PR if none exists
5. Write summary to `/tmp/claude-code-result-insights.md` (files changed, branch, commit hash, PR URL, worktree list)

## Claude Code Spawn Commands

### Step 1 — Worktree Management
```
claude -p --dangerously-skip-permissions 'WORKTREE MANAGEMENT TASK (do NOT write any application code):

0. SAFETY CHECK — Verify main repo is on the main branch:
   Run: git branch --show-current
   If NOT on main: run `git checkout main` IMMEDIATELY.

1. UPDATE MAIN: git pull origin main

2. CLEANUP — Run `git worktree list`. For each worktree (skip main repo line):
   - Check if branch has a merged PR: `gh pr list --head <branch> --state merged --json number`
   - If merged: `git worktree remove <path> && git branch -d <branch>`
   - Run `git worktree prune`

3. SELECT OR CREATE — For the task: "SHORT_TASK_DESCRIPTION"
   - For any NEW task, create a new worktree+branch:
     `git worktree add /home/ubuntu/.openclaw/workspace-insights-ui/worktrees/<branch-name> -b <branch-name> main`
   - Only reuse existing worktree for explicit continuations.

4. VERIFY — Confirm main repo is still on main.

5. Write result to /tmp/claude-code-worktree-insights.md'
```

### Step 2 — Do Work in Worktree
```
claude -p --dangerously-skip-permissions 'SAFETY CHECK (do this FIRST):
1. Run: pwd — must contain "/worktrees/"
2. Run: git branch --show-current — must NOT be "main"

TASK: DESCRIBE_THE_ACTUAL_TASK

Read CLAUDE.md at the repo root for full workflow instructions.

RULES:
- Stay on the task branch. Do NOT switch branches.
- Do NOT run git commands in the main repo.

When finished:
1. Run: yarn lint && yarn prettier-check && yarn build
2. Commit and push
3. Create PR if none exists: gh pr create --base main --head <branch>
4. Write summary to /tmp/claude-code-result-insights.md'
```

## Build Commands
- `yarn lint` / `yarn lint-fix`
- `yarn prettier-check` / `yarn prettier-fix`
- `yarn build`
- `yarn compile`

## Key References
- Repo root `CLAUDE.md` for full development guidelines
- `docs/ai-knowledge/AIKnowledge.md` for architecture context
- `docs/ai-knowledge/projects/insights-ui/` for project-specific docs

## Rules
- Never write code directly — always delegate to Claude Code CLI
- Always use the two-step worktree flow: Step 1 (manage) -> Step 2 (work)
- Never commit on `main` — all work happens on feature branches in worktrees
- Always commit, push, and create PR for code changes
- Pre-commit sequence: lint -> prettier-check -> build -> commit
