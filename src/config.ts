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
export const INSIGHTS_UI_MAIN_REPO: string = optionalEnv("INSIGHTS_UI_MAIN_REPO", "/home/ubuntu/discord-claude-bot/insights-ui/dodao-ui");
export const INSIGHTS_UI_WORKTREE_BASE: string = optionalEnv("INSIGHTS_UI_WORKTREE_BASE", "/home/ubuntu/discord-claude-bot/insights-ui/worktrees");
export const INSIGHTS_UI_WORKTREE_RESULT = "/tmp/claude-code-worktree-insights.md";
export const INSIGHTS_UI_TASK_RESULT = "/tmp/claude-code-result-insights.md";
export const INSIGHTS_UI_ROUTE_RESULT = "/tmp/claude-code-route-insights.json";
export const INSIGHTS_UI_EXCHANGE_LOG = "/home/ubuntu/discord-claude-bot/insights-ui/discord-message-exchange.md";
export const INSIGHTS_UI_THREAD_LOGS_DIR = "/home/ubuntu/discord-claude-bot/insights-ui/discord-thread-logs";

// --- Scraping-Lambdas ---
export const SCRAPING_LAMBDAS_CHANNEL: string = optionalEnv("SCRAPING_LAMBDAS_CHANNEL", "1493070478577897543");
export const SCRAPING_LAMBDAS_MAIN_REPO: string = optionalEnv(
  "SCRAPING_LAMBDAS_MAIN_REPO",
  "/home/ubuntu/discord-claude-bot/scraping-lambdas/scraping-lambdas",
);
export const SCRAPING_LAMBDAS_WORKTREE_BASE: string = optionalEnv(
  "SCRAPING_LAMBDAS_WORKTREE_BASE",
  "/home/ubuntu/discord-claude-bot/scraping-lambdas/worktrees",
);
export const SCRAPING_LAMBDAS_WORKTREE_RESULT = "/tmp/claude-code-worktree-scraping-lambdas.md";
export const SCRAPING_LAMBDAS_TASK_RESULT = "/tmp/claude-code-result-scraping-lambdas.md";
export const SCRAPING_LAMBDAS_ROUTE_RESULT = "/tmp/claude-code-route-scraping-lambdas.json";
export const SCRAPING_LAMBDAS_EXCHANGE_LOG = "/home/ubuntu/discord-claude-bot/scraping-lambdas/discord-message-exchange.md";
export const SCRAPING_LAMBDAS_THREAD_LOGS_DIR = "/home/ubuntu/discord-claude-bot/scraping-lambdas/discord-thread-logs";

// --- Discord-Bot (self) ---
export const DISCORD_BOT_CHANNEL: string = optionalEnv("DISCORD_BOT_CHANNEL", "1494631048414236734");
export const DISCORD_BOT_MAIN_REPO: string = optionalEnv("DISCORD_BOT_MAIN_REPO", "/home/ubuntu/discord-claude-bot/discord-bot/discord-claude-bot");
export const DISCORD_BOT_WORKTREE_BASE: string = optionalEnv("DISCORD_BOT_WORKTREE_BASE", "/home/ubuntu/discord-claude-bot/discord-bot/worktrees");
export const DISCORD_BOT_WORKTREE_RESULT = "/tmp/claude-code-worktree-discord-bot.md";
export const DISCORD_BOT_TASK_RESULT = "/tmp/claude-code-result-discord-bot.md";
export const DISCORD_BOT_ROUTE_RESULT = "/tmp/claude-code-route-discord-bot.json";
export const DISCORD_BOT_EXCHANGE_LOG = "/home/ubuntu/discord-claude-bot/discord-bot/discord-message-exchange.md";
export const DISCORD_BOT_THREAD_LOGS_DIR = "/home/ubuntu/discord-claude-bot/discord-bot/discord-thread-logs";

// --- Outreach-Data ---
export const OUTREACH_DATA_CHANNEL: string = optionalEnv("OUTREACH_DATA_CHANNEL", "1491111325173022933");
export const OUTREACH_DATA_WORKSPACE: string = optionalEnv("OUTREACH_DATA_WORKSPACE", "/home/ubuntu/.openclaw/workspace-outreach-data");
export const OUTREACH_DATA_RESULT = "/tmp/claude-code-result-outreach-data.md";

// --- Gmail ---
export const GMAIL_CHANNEL: string = optionalEnv("GMAIL_CHANNEL", "1491111325173022934");
export const GMAIL_WORKSPACE: string = optionalEnv("GMAIL_WORKSPACE", "/home/ubuntu/.openclaw/workspace-gmail");
export const GMAIL_RESULT = "/tmp/claude-code-result-gmail.md";

// --- Gemini API (audio transcription) ---
export const GOOGLE_API_KEY: string = optionalEnv("GOOGLE_API_KEY", "");
export const GEMINI_TRANSCRIBE_MODEL: string = optionalEnv("GEMINI_TRANSCRIBE_MODEL", "gemini-2.5-flash");
