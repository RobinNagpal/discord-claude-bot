import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { REST, Routes, SlashCommandBuilder, ChannelType, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import {
  DISCORD_APP_ID,
  DISCORD_GUILD_ID,
  DISCORD_TOKEN,
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

async function handleClaudeCodeUsage(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const resultFile = "/tmp/claude-code-usage-slash.md";
  try {
    if (existsSync(resultFile)) rmSync(resultFile, { force: true });
  } catch {
    // best-effort cleanup
  }
  const prompt = `Produce a Claude Code subscription-usage report and write it to ${resultFile}. Keep it under ~20 lines of plain text, Discord-friendly.

Focus on two windows:
1. **Current session** — the active 5-hour block (the window Claude Code uses to enforce per-session caps). Anchor it on the earliest assistant turn timestamp in the last 5 hours; if no activity in the last 5 hours, say "no active session".
2. **Rolling week** — the last 7 days (the window Max plans use for weekly caps).

How to get the data (try in order, stop once one works):
1. If the \`ccusage\` CLI is installed (\`which ccusage\`), prefer it. \`ccusage blocks --active --json\` gives the current session block with token totals; \`ccusage daily --json --since $(date -u -d '7 days ago' +%Y%m%d)\` gives the last 7 days. Sum the daily entries for the weekly total.
2. Otherwise, walk \`~/.claude/projects/*/*.jsonl\` and tally token usage from assistant-turn \`usage\` objects. Each JSONL line has a \`timestamp\` (ISO) and, for assistant turns, a \`message.usage\` object with \`input_tokens\`, \`output_tokens\`, \`cache_creation_input_tokens\`, \`cache_read_input_tokens\`, and \`model\`. Filter by timestamp for each window.
3. If neither data source is available or has zero records, say so in one short line and suggest installing \`ccusage\` — do NOT invent numbers.

For each window, report:
- Total input / output / cache-read / cache-creation tokens (sum them; don't double-count cache reads as input).
- Approximate cost in USD, derived from per-model pricing in the usage records if available. If pricing isn't in the data, omit the cost line rather than guessing.
- Per-model split (Opus / Sonnet / Haiku) by output tokens, as percentages.
- For the session window only: the session start time (local time, \`America/New_York\`) and how much of the 5-hour window remains.

If you can detect the user's plan tier (Pro / Max 5x / Max 20x) from any hint in the data, show the fraction of the known per-session and weekly caps consumed. If you cannot detect the plan, omit that line rather than guessing — just show the absolute usage.

Output format — plain text, no markdown headings, no preamble, no trailing commentary:
  Session (started HH:MM ET, N h M m remaining):
    tokens: input=X, output=Y, cache_read=Z, cache_creation=W
    cost:   ~$N      (omit if unknown)
    models: Opus=X%, Sonnet=Y%, Haiku=Z%
    plan:   P% of <plan> session cap used   (omit line if plan unknown)
  Week (last 7 days):
    tokens: input=X, output=Y, cache_read=Z, cache_creation=W
    cost:   ~$N
    models: Opus=X%, Sonnet=Y%, Haiku=Z%
    plan:   P% of <plan> weekly cap used   (omit line if plan unknown)

This output is posted to Discord verbatim. Do not add explanations, caveats, or a summary line after it.`;

  try {
    await runClaude(prompt);
    const body = existsSync(resultFile) ? readFileSync(resultFile, "utf-8").trim() : "";
    if (!body) {
      await interaction.editReply("claude-code-usage: Claude produced no output (check logs).");
      return;
    }
    await sendLong(interaction, `**Claude Code usage**\n\`\`\`\n${body}\n\`\`\``);
  } catch (err) {
    await interaction.editReply(`claude-code-usage failed: ${formatError(err)}`);
  }
}

export async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "compact") await handleCompact(interaction);
  else if (interaction.commandName === "list-worktrees") await handleListWorktrees(interaction);
  else if (interaction.commandName === "delete-worktree") await handleDeleteWorktree(interaction);
  else if (interaction.commandName === "claude-code-usage") await handleClaudeCodeUsage(interaction);
}
