import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
import { formatError, splitMessage } from "./discord.js";

const execFileAsync = promisify(execFile);

const commands = [
  new SlashCommandBuilder().setName("compact").setDescription("Compact the Claude Code session for this worktree thread."),
  new SlashCommandBuilder().setName("list-worktrees").setDescription("List git worktrees for this project channel."),
  new SlashCommandBuilder()
    .setName("delete-worktree")
    .setDescription("Delete a worktree (and its branch) from this project.")
    .addStringOption((opt) => opt.setName("name").setDescription("Worktree/branch name to delete").setRequired(true)),
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
    await interaction.editReply(`Compact failed: ${formatError(err)}`);
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
  const lines: string[] = [];
  let worktreeRemoved = false;
  try {
    const { stdout, stderr } = await runGit(ctx.mainRepo, ["worktree", "remove", "--force", worktreePath]);
    worktreeRemoved = true;
    lines.push(`Removed worktree \`${worktreePath}\`.`);
    if (stdout.trim()) lines.push(stdout.trim());
    if (stderr.trim()) lines.push(stderr.trim());
  } catch (err) {
    lines.push(`Worktree remove failed: ${formatError(err)}`);
  }

  try {
    const { stdout, stderr } = await runGit(ctx.mainRepo, ["branch", "-D", name]);
    lines.push(`Deleted branch \`${name}\`.`);
    if (stdout.trim()) lines.push(stdout.trim());
    if (stderr.trim()) lines.push(stderr.trim());
  } catch (err) {
    lines.push(`Branch delete failed: ${formatError(err)}`);
  }

  const header = worktreeRemoved ? `**delete-worktree ${name}**` : `**delete-worktree ${name}** (failed)`;
  await sendLong(interaction, `${header}\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
}

export async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "compact") await handleCompact(interaction);
  else if (interaction.commandName === "list-worktrees") await handleListWorktrees(interaction);
  else if (interaction.commandName === "delete-worktree") await handleDeleteWorktree(interaction);
}
