import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { REST, Routes, SlashCommandBuilder, ChannelType, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import {
  ALLOWED_USERS,
  DEPLOYMENT_REPO,
  DEPLOYMENT_SERVICE,
  DISCORD_APP_ID,
  DISCORD_GUILD_ID,
  DISCORD_TOKEN,
  LOCK_FILE,
  INSIGHTS_UI_CHANNEL,
  INSIGHTS_UI_MAIN_REPO,
  INSIGHTS_UI_WORKTREE_BASE,
  SCRAPING_LAMBDAS_CHANNEL,
  SCRAPING_LAMBDAS_MAIN_REPO,
  SCRAPING_LAMBDAS_WORKTREE_BASE,
  DISCORD_BOT_CHANNEL,
  DISCORD_BOT_MAIN_REPO,
  DISCORD_BOT_WORKTREE_BASE,
} from "./config.js";
import { runClaude } from "./claude.js";
import { formatError, formatClaudeError, formatExecError, splitMessage } from "./discord.js";

const execFileAsync = promisify(execFile);

const commands = [
  new SlashCommandBuilder().setName("compact").setDescription("Compact the Claude Code session for this worktree thread."),
  new SlashCommandBuilder().setName("list-worktrees").setDescription("List git worktrees for this project channel."),
  new SlashCommandBuilder()
    .setName("delete-worktree")
    .setDescription("Delete a worktree (and its branch) from this project.")
    .addStringOption((opt) => opt.setName("name").setDescription("Worktree/branch name to delete").setRequired(true)),
  new SlashCommandBuilder()
    .setName("claude-code-usage")
    .setDescription("Report Claude Code subscription usage for the current 5-hour session and rolling week."),
  new SlashCommandBuilder()
    .setName("claude-code-effort")
    .setDescription("Change the default Claude Code effort level for future sessions.")
    .addStringOption((opt) =>
      opt
        .setName("level")
        .setDescription("Effort level to switch to.")
        .setRequired(true)
        .addChoices(
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh", value: "xhigh" },
          { name: "auto (reset to model default)", value: "auto" },
        ),
    ),
  new SlashCommandBuilder().setName("pull-bot-and-restart").setDescription("Pull the latest bot code from main, rebuild, and restart the systemd service."),
];

export async function registerSlashCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const body = commands.map((c) => c.toJSON());
  try {
    if (DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID), { body });
      console.log(`[slash] registered ${body.length} guild command(s) in ${DISCORD_GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(DISCORD_APP_ID), { body });
      console.log(`[slash] registered ${body.length} global command(s)`);
    }
  } catch (err) {
    console.error(`[slash] failed to register commands: ${formatError(err)}`);
    console.error("[slash] re-invite the bot with scope=bot+applications.commands if you see a 'Missing Access' error.");
  }
}

function resolveWorktreePath(parentId: string | null, threadName: string): string | null {
  if (parentId === INSIGHTS_UI_CHANNEL) return join(INSIGHTS_UI_WORKTREE_BASE, threadName);
  if (parentId === SCRAPING_LAMBDAS_CHANNEL) return join(SCRAPING_LAMBDAS_WORKTREE_BASE, threadName);
  if (parentId === DISCORD_BOT_CHANNEL) return join(DISCORD_BOT_WORKTREE_BASE, threadName);
  return null;
}

interface ProjectContext {
  mainRepo: string;
  worktreeBase: string;
  projectName: string;
}

function resolveProjectContext(interaction: ChatInputCommandInteraction): ProjectContext | null {
  const channel = interaction.channel;
  if (!channel) return null;
  const isThread = channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread;
  const projectChannelId = isThread ? channel.parentId : channel.id;
  if (projectChannelId === INSIGHTS_UI_CHANNEL) {
    return { mainRepo: INSIGHTS_UI_MAIN_REPO, worktreeBase: INSIGHTS_UI_WORKTREE_BASE, projectName: "insights-ui" };
  }
  if (projectChannelId === SCRAPING_LAMBDAS_CHANNEL) {
    return { mainRepo: SCRAPING_LAMBDAS_MAIN_REPO, worktreeBase: SCRAPING_LAMBDAS_WORKTREE_BASE, projectName: "scraping-lambdas" };
  }
  if (projectChannelId === DISCORD_BOT_CHANNEL) {
    return { mainRepo: DISCORD_BOT_MAIN_REPO, worktreeBase: DISCORD_BOT_WORKTREE_BASE, projectName: "discord-bot" };
  }
  return null;
}

function validateWorktreeName(name: string): string | null {
  if (!name) return "name is required";
  if (name.startsWith("-")) return "name cannot start with '-'";
  if (name.includes("..") || name.includes("\0")) return "name contains invalid characters";
  return null;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
}

async function sendLong(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
  const chunks = splitMessage(text);
  if (chunks.length === 0) {
    await interaction.editReply("(empty)");
    return;
  }
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

async function handleCompact(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) {
    await interaction.reply({ content: "`/compact` must be run inside a worktree thread.", flags: MessageFlags.Ephemeral });
    return;
  }
  const worktreePath = resolveWorktreePath(channel.parentId, channel.name);
  if (!worktreePath) {
    await interaction.reply({
      content: "This thread is not a worktree thread (parent channel is not insights-ui, scraping-lambdas, or discord-bot).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!existsSync(worktreePath)) {
    await interaction.reply({ content: `Worktree \`${worktreePath}\` does not exist.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  try {
    const out = await runClaude("/compact", { cwd: worktreePath, continueSession: true });
    const cleaned = out.trim();
    let msg = `Compacted session for \`${channel.name}\`.`;
    if (cleaned && cleaned !== "(no output)") msg += `\n\`\`\`\n${cleaned}\n\`\`\``;
    await sendLong(interaction, msg);
  } catch (err) {
    await interaction.editReply(formatClaudeError(err, "Compact failed"));
  }
}

async function handleListWorktrees(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = resolveProjectContext(interaction);
  if (!ctx) {
    await interaction.reply({
      content: "`/list-worktrees` must be run in a project channel or its thread (insights-ui, scraping-lambdas, discord-bot).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply();
  try {
    const { stdout } = await runGit(ctx.mainRepo, ["worktree", "list"]);
    const body = stdout.trim() || "(no worktrees)";
    await sendLong(interaction, `**${ctx.projectName} worktrees**\n\`\`\`\n${body}\n\`\`\``);
  } catch (err) {
    await interaction.editReply(`list-worktrees failed: ${formatError(err)}`);
  }
}

async function removeWorktreeWithFallbacks(mainRepo: string, worktreePath: string): Promise<{ log: string[]; removed: boolean }> {
  const log: string[] = [];

  try {
    await runGit(mainRepo, ["worktree", "remove", "--force", worktreePath]);
    log.push(`Removed worktree \`${worktreePath}\`.`);
    return { log, removed: true };
  } catch (err) {
    log.push(`git worktree remove --force failed:\n${formatExecError(err)}`);
  }

  try {
    await runGit(mainRepo, ["worktree", "prune", "--expire", "now"]);
    log.push("Ran git worktree prune --expire now.");
  } catch (err) {
    log.push(`git worktree prune failed:\n${formatExecError(err)}`);
  }

  try {
    await runGit(mainRepo, ["worktree", "remove", "--force", worktreePath]);
    log.push(`Removed worktree \`${worktreePath}\` after prune.`);
    return { log, removed: true };
  } catch (err) {
    log.push(`retry after prune failed:\n${formatExecError(err)}`);
  }

  if (existsSync(worktreePath)) {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      log.push(`rm -rf \`${worktreePath}\` succeeded.`);
    } catch (err) {
      log.push(`rm -rf failed: ${formatError(err)}`);
      return { log, removed: false };
    }
  } else {
    log.push("(worktree path does not exist on disk)");
  }

  try {
    await runGit(mainRepo, ["worktree", "prune", "--expire", "now"]);
    log.push("Pruned stale worktree metadata.");
    return { log, removed: true };
  } catch (err) {
    log.push(`final git worktree prune failed:\n${formatExecError(err)}`);
    return { log, removed: false };
  }
}

function isBranchNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const stderr = typeof (err as { stderr?: string }).stderr === "string" ? (err as { stderr: string }).stderr : "";
  return /branch .* not found/i.test(stderr);
}

async function handleDeleteWorktree(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = resolveProjectContext(interaction);
  if (!ctx) {
    await interaction.reply({
      content: "`/delete-worktree` must be run in a project channel or its thread (insights-ui, scraping-lambdas, discord-bot).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const name = interaction.options.getString("name", true).trim();
  const validationError = validateWorktreeName(name);
  if (validationError) {
    await interaction.reply({ content: `Invalid worktree name: ${validationError}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const worktreePath = join(ctx.worktreeBase, name);

  await interaction.deferReply();

  const { log: worktreeLog, removed: worktreeRemoved } = await removeWorktreeWithFallbacks(ctx.mainRepo, worktreePath);
  const lines: string[] = [...worktreeLog];

  if (worktreeRemoved) {
    try {
      await runGit(ctx.mainRepo, ["branch", "-D", name]);
      lines.push(`Deleted branch \`${name}\`.`);
    } catch (err) {
      if (isBranchNotFoundError(err)) {
        lines.push(`Branch \`${name}\` was already deleted.`);
      } else {
        lines.push(`Branch delete failed:\n${formatExecError(err)}`);
      }
    }
  } else {
    lines.push(`Skipping branch delete — worktree removal did not complete.`);
  }

  const header = worktreeRemoved ? `**delete-worktree ${name}**` : `**delete-worktree ${name}** (failed)`;
  await sendLong(interaction, `${header}\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
}

interface UsageBucket {
  utilization: number;
  resets_at: string | null;
}

interface UsageResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
    currency?: string | null;
  } | null;
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

// Claude Code persists only these levels in settings.json (its schema rejects
// "max" — that's CLI-session-only). "auto" is our sentinel for clearing the
// override and letting Claude fall back to the model default.
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "auto"] as const;
type EffortLevel = Exclude<(typeof EFFORT_LEVELS)[number], "auto">;

interface ClaudeSettings {
  effortLevel?: string;
  [key: string]: unknown;
}

function getSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? join(process.env.HOME ?? "/home/ubuntu", ".claude", "settings.json");
}

function readClaudeSettings(): { settings: ClaudeSettings; path: string; existed: boolean } {
  const path = getSettingsPath();
  if (!existsSync(path)) return { settings: {}, path, existed: false };
  try {
    const raw = readFileSync(path, "utf-8");
    if (!raw.trim()) return { settings: {}, path, existed: true };
    const parsed = JSON.parse(raw) as ClaudeSettings;
    return { settings: parsed, path, existed: true };
  } catch {
    return { settings: {}, path, existed: true };
  }
}

interface EffortStatus {
  level: string;
  source: "env" | "settings" | "default";
  envOverride: string | null;
}

// CLAUDE_CODE_EFFORT_LEVEL env var takes precedence over settings.json; if
// neither is set Claude falls back to the per-model default.
function getCurrentEffort(): EffortStatus {
  const envLevel = process.env.CLAUDE_CODE_EFFORT_LEVEL?.trim();
  if (envLevel) return { level: envLevel, source: "env", envOverride: envLevel };
  const { settings } = readClaudeSettings();
  if (typeof settings.effortLevel === "string" && settings.effortLevel.trim() !== "") {
    return { level: settings.effortLevel, source: "settings", envOverride: null };
  }
  return { level: "auto (model default)", source: "default", envOverride: null };
}

function describeEffortSource(status: EffortStatus): string {
  if (status.source === "env") return "CLAUDE_CODE_EFFORT_LEVEL env var";
  if (status.source === "settings") return getSettingsPath();
  return "model default";
}

function formatResetTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diffMs = d.getTime() - now;
  const diffMin = Math.round(diffMs / 60_000);
  const absMin = Math.abs(diffMin);
  let relative: string;
  if (absMin < 60) relative = `${String(absMin)}m`;
  else if (absMin < 60 * 24) relative = `${String(Math.round(absMin / 60))}h`;
  else relative = `${String(Math.round(absMin / (60 * 24)))}d`;
  const when = diffMs >= 0 ? `in ${relative}` : `${relative} ago`;
  const local = d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${local} ET (${when})`;
}

function formatBucket(label: string, bucket: UsageBucket | null | undefined): string {
  if (!bucket || typeof bucket.utilization !== "number") return `${label}: (no data)`;
  const pct = bucket.utilization.toFixed(1);
  return `${label}: ${pct}% used, resets ${formatResetTime(bucket.resets_at)}`;
}

async function fetchClaudeUsage(): Promise<{ data: UsageResponse; plan: string | undefined; tier: string | undefined }> {
  const credPath = process.env.CLAUDE_CREDENTIALS_PATH ?? join(process.env.HOME ?? "/home/ubuntu", ".claude", ".credentials.json");
  if (!existsSync(credPath)) {
    throw new Error(`Claude credentials not found at ${credPath}`);
  }
  const raw = readFileSync(credPath, "utf-8");
  const creds = JSON.parse(raw) as ClaudeCredentials;
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) throw new Error("No OAuth access token in credentials file");

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "discord-claude-bot/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${String(res.status)}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as UsageResponse;
  return { data, plan: creds.claudeAiOauth?.subscriptionType, tier: creds.claudeAiOauth?.rateLimitTier };
}

async function handleClaudeCodeUsage(interaction: ChatInputCommandInteraction): Promise<void> {
  console.log(`[claude-code-usage] invoked by ${interaction.user.tag} (${interaction.user.id})`);
  await interaction.deferReply();
  try {
    const { data, plan, tier } = await fetchClaudeUsage();
    const lines: string[] = [];
    if (plan || tier) {
      const bits = [plan ? `plan=${plan}` : null, tier ? `tier=${tier}` : null].filter((x): x is string => x !== null);
      lines.push(bits.join(", "));
    }
    lines.push(formatBucket("Current 5h session", data.five_hour));
    lines.push(formatBucket("Current week (all)", data.seven_day));
    if (data.seven_day_opus) lines.push(formatBucket("Current week (Opus)", data.seven_day_opus));
    if (data.seven_day_sonnet) lines.push(formatBucket("Current week (Sonnet)", data.seven_day_sonnet));
    const extra = data.extra_usage;
    if (extra?.is_enabled && typeof extra.utilization === "number") {
      lines.push(`Extra usage: ${extra.utilization.toFixed(1)}% used of ${extra.monthly_limit ?? "—"} ${extra.currency ?? ""}`.trim());
    }
    const effort = getCurrentEffort();
    lines.push(`Effort level: ${effort.level} (source: ${describeEffortSource(effort)})`);
    console.log(`[claude-code-usage] success: ${lines.length} lines`);
    await sendLong(interaction, `**Claude Code usage**\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
  } catch (err) {
    console.error(`[claude-code-usage] failed: ${formatError(err)}`);
    await interaction.editReply(`claude-code-usage failed: ${formatError(err)}`);
  }
}

async function handleClaudeCodeEffort(interaction: ChatInputCommandInteraction): Promise<void> {
  const raw = interaction.options.getString("level", true).trim();
  const level = raw.toLowerCase();
  if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
    await interaction.reply({
      content: `Invalid effort level \`${raw}\`. Valid levels: ${EFFORT_LEVELS.join(", ")}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  console.log(`[claude-code-effort] invoked by ${interaction.user.tag} (${interaction.user.id}) -> ${level}`);
  await interaction.deferReply();
  try {
    const { settings, path } = readClaudeSettings();
    const previous = typeof settings.effortLevel === "string" ? settings.effortLevel : "(unset)";
    if (level === "auto") delete settings.effortLevel;
    else settings.effortLevel = level as EffortLevel;
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

    const shown = level === "auto" ? "auto (model default)" : level;
    const lines = [`Claude Code effort level: \`${previous}\` -> \`${shown}\``, `Wrote \`${path}\`.`, "Applies to new Claude Code sessions."];
    const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.trim();
    if (envOverride) {
      lines.push(`Warning: CLAUDE_CODE_EFFORT_LEVEL=\`${envOverride}\` is set in the bot's environment and overrides settings.json.`);
    }
    console.log(`[claude-code-effort] success: ${previous} -> ${level}`);
    await interaction.editReply(lines.join("\n"));
  } catch (err) {
    console.error(`[claude-code-effort] failed: ${formatError(err)}`);
    await interaction.editReply(`claude-code-effort failed: ${formatError(err)}`);
  }
}

async function handlePullBotAndRestart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (ALLOWED_USERS && !ALLOWED_USERS.includes(interaction.user.id)) {
    await interaction.reply({ content: "You are not authorized to restart the bot.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const lines: string[] = [];
  const repo = DEPLOYMENT_REPO;
  const service = DEPLOYMENT_SERVICE;

  try {
    const fetch = await runGit(repo, ["fetch", "origin", "main"]);
    const fetchOut = `${fetch.stdout}${fetch.stderr}`.trim();
    lines.push(`$ git fetch origin main\n${fetchOut || "(up to date)"}`);
  } catch (err) {
    await interaction.editReply(`fetch failed:\n${formatExecError(err)}`);
    return;
  }

  let pullOut: string;
  try {
    const pull = await runGit(repo, ["pull", "--ff-only", "origin", "main"]);
    pullOut = `${pull.stdout}${pull.stderr}`.trim();
    lines.push(`$ git pull --ff-only origin main\n${pullOut || "(already up to date)"}`);
  } catch (err) {
    await interaction.editReply(`pull failed:\n${formatExecError(err)}`);
    return;
  }

  try {
    const build = await execFileAsync("npm", ["run", "build"], { cwd: repo, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    const buildTail = `${build.stdout}${build.stderr}`.trim().split("\n").slice(-5).join("\n");
    lines.push(`$ npm run build\n${buildTail || "(ok)"}`);
  } catch (err) {
    await interaction.editReply(`build failed:\n${formatExecError(err)}`);
    return;
  }

  lines.push(`\nRestarting \`${service}\`…`);
  await sendLong(interaction, `**pull-bot-and-restart**\n\`\`\`\n${lines.join("\n\n")}\n\`\`\``);

  // Belt-and-suspenders: gracefulShutdown's exit hook normally clears this,
  // but if shutdown is interrupted (SIGKILL after TimeoutStopSec, reparent
  // to init, crash mid-drain) the stale lock pins systemd's auto-restart
  // loop into the acquireSingletonLock bailout. Clearing it here means the
  // next bot to start sees a clean slate.
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    // best-effort
  }

  // Fire-and-forget: spawn detached so systemctl's SIGTERM to us doesn't
  // kill the restart command mid-flight. unref() lets the parent exit
  // cleanly when systemd signals it.
  const child = spawn("systemctl", ["--user", "restart", service], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "compact") await handleCompact(interaction);
  else if (interaction.commandName === "list-worktrees") await handleListWorktrees(interaction);
  else if (interaction.commandName === "delete-worktree") await handleDeleteWorktree(interaction);
  else if (interaction.commandName === "claude-code-usage") await handleClaudeCodeUsage(interaction);
  else if (interaction.commandName === "claude-code-effort") await handleClaudeCodeEffort(interaction);
  else if (interaction.commandName === "pull-bot-and-restart") await handlePullBotAndRestart(interaction);
}
