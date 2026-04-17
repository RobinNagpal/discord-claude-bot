import { Client, GatewayIntentBits, ChannelType, type Message, type ThreadChannel } from "discord.js";
import {
  DISCORD_TOKEN,
  PREFIX,
  ALLOWED_CHANNELS,
  ALLOWED_USERS,
  MAX_CONCURRENT,
  INSIGHTS_UI_CHANNEL,
  SCRAPING_LAMBDAS_CHANNEL,
  DISCORD_BOT_CHANNEL,
  OUTREACH_DATA_CHANNEL,
  GMAIL_CHANNEL,
} from "./config.js";
import { formatError, replyInChunks } from "./discord.js";
import { getAudioAttachments, transcribeAttachments } from "./audio.js";
import { handleGeneral } from "./handlers/general.js";
import { handleInsightsUI, handleInsightsUIThread } from "./handlers/insights-ui.js";
import { handleScrapingLambdas, handleScrapingLambdasThread } from "./handlers/scraping-lambdas.js";
import { handleDiscordBot, handleDiscordBotThread } from "./handlers/discord-bot.js";
import { handleOutreachData } from "./handlers/outreach-data.js";
import { handleGmail } from "./handlers/gmail.js";
import { startJobScheduler } from "./jobs/jobs.js";

let activeJobs = 0;
let shuttingDown = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown"}`);
  void startJobScheduler(client);
});

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  const channel = message.channel;
  const isThread = channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread;
  const inInsightsUiThread = isThread && channel.parentId === INSIGHTS_UI_CHANNEL;
  const inScrapingLambdasThread = isThread && channel.parentId === SCRAPING_LAMBDAS_CHANNEL;
  const inDiscordBotThread = isThread && channel.parentId === DISCORD_BOT_CHANNEL;
  const inWorktreeThread = inInsightsUiThread || inScrapingLambdasThread || inDiscordBotThread;

  const audioAttachments = inWorktreeThread ? getAudioAttachments(message) : [];
  const hasAudio = audioAttachments.length > 0;

  if (!hasAudio) {
    if (!message.content.startsWith(PREFIX)) return;
    const afterPrefix = message.content.slice(PREFIX.length);
    if (afterPrefix.length > 0 && afterPrefix[0] !== " ") return;
  }

  const textPrompt = message.content.startsWith(PREFIX) ? message.content.slice(PREFIX.length).trim() : message.content.trim();

  if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(message.channelId)) return;

  if (shuttingDown) {
    await message.reply("Bot is restarting for an update — please resend in a moment.");
    return;
  }

  if (ALLOWED_USERS && !ALLOWED_USERS.includes(message.author.id)) {
    await message.reply("You are not authorized to use this bot.");
    return;
  }

  if (!hasAudio && !textPrompt) {
    await message.reply(`Please provide a prompt after \`${PREFIX}\`.`);
    return;
  }

  if (activeJobs >= MAX_CONCURRENT) {
    await message.reply("Too many requests in progress. Please wait and try again.");
    return;
  }

  activeJobs++;

  try {
    let prompt = textPrompt;
    if (hasAudio) {
      await message.reply(`Transcribing ${audioAttachments.length} audio attachment(s)...`);
      let transcript: string;
      try {
        transcript = await transcribeAttachments(audioAttachments);
      } catch (err) {
        await message.reply(`Transcription failed: ${formatError(err)}`);
        return;
      }
      if (!transcript) {
        await message.reply("Transcription returned no text.");
        return;
      }
      await replyInChunks(message, `**Transcript:**\n${transcript}`);
      prompt = [textPrompt, transcript].filter((s) => s.length > 0).join("\n\n");
    }

    if (inInsightsUiThread) {
      await handleInsightsUIThread(message, channel as ThreadChannel, prompt);
    } else if (inScrapingLambdasThread) {
      await handleScrapingLambdasThread(message, channel as ThreadChannel, prompt);
    } else if (inDiscordBotThread) {
      await handleDiscordBotThread(message, channel as ThreadChannel, prompt);
    } else if (message.channelId === INSIGHTS_UI_CHANNEL) {
      await handleInsightsUI(message, prompt);
    } else if (message.channelId === SCRAPING_LAMBDAS_CHANNEL) {
      await handleScrapingLambdas(message, prompt);
    } else if (message.channelId === DISCORD_BOT_CHANNEL) {
      await handleDiscordBot(message, prompt);
    } else if (message.channelId === OUTREACH_DATA_CHANNEL) {
      await handleOutreachData(message, prompt);
    } else if (message.channelId === GMAIL_CHANNEL) {
      await handleGmail(message, prompt);
    } else {
      await handleGeneral(message, prompt);
    }
  } catch (err) {
    await message.reply(`Error: ${formatError(err)}`);
  } finally {
    activeJobs--;
  }
});

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal}, draining ${activeJobs} active job(s)...`);

  const deadline = Date.now() + 32 * 60 * 1000;
  while (activeJobs > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (activeJobs > 0) {
    console.log(`[shutdown] drain timeout, ${activeJobs} job(s) still running, exiting anyway`);
  } else {
    console.log("[shutdown] drained cleanly");
  }

  try {
    await client.destroy();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

client.login(DISCORD_TOKEN);
