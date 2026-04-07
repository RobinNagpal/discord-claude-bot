import "dotenv/config";

function parseList(val: string | undefined): string[] | null {
  if (!val?.trim()) return null;
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`${key} is required. Set it in .env or as an environment variable.`);
    process.exit(1);
  }
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

// --- Bot config ---
export const DISCORD_TOKEN: string = requireEnv("DISCORD_TOKEN");
export const PREFIX: string = optionalEnv("PREFIX", "!claude");
export const ALLOWED_CHANNELS: string[] | null = parseList(process.env.ALLOWED_CHANNELS);
export const ALLOWED_USERS: string[] | null = parseList(process.env.ALLOWED_USERS);
export const MAX_CONCURRENT: number = optionalEnvInt("MAX_CONCURRENT", 3);
export const CLAUDE_TIMEOUT: number = optionalEnvInt("CLAUDE_TIMEOUT", 300_000);
export const MAX_BUFFER: number = optionalEnvInt("MAX_BUFFER", 1024 * 1024);

// --- Insights-UI ---
export const INSIGHTS_UI_CHANNEL: string = optionalEnv("INSIGHTS_UI_CHANNEL", "1491102767224324309");
export const INSIGHTS_UI_MAIN_REPO: string = optionalEnv("INSIGHTS_UI_MAIN_REPO", "/home/ubuntu/.openclaw/workspace-insights-ui/dodao-ui");
export const INSIGHTS_UI_WORKTREE_BASE: string = optionalEnv("INSIGHTS_UI_WORKTREE_BASE", "/home/ubuntu/.openclaw/workspace-insights-ui/worktrees");
export const INSIGHTS_UI_WORKTREE_RESULT = "/tmp/claude-code-worktree-insights.md";
export const INSIGHTS_UI_TASK_RESULT = "/tmp/claude-code-result-insights.md";

// --- Outreach-Data ---
export const OUTREACH_DATA_CHANNEL: string = optionalEnv("OUTREACH_DATA_CHANNEL", "1491111325173022933");
export const OUTREACH_DATA_WORKSPACE: string = optionalEnv("OUTREACH_DATA_WORKSPACE", "/home/ubuntu/.openclaw/workspace-outreach-data");
export const OUTREACH_DATA_RESULT = "/tmp/claude-code-result-outreach-data.md";
