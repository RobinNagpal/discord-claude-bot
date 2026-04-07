import { Client, GatewayIntentBits, type Message } from "discord.js";
import { DISCORD_TOKEN, PREFIX, ALLOWED_CHANNELS, ALLOWED_USERS, MAX_CONCURRENT, INSIGHTS_UI_CHANNEL, OUTREACH_DATA_CHANNEL } from "./config.js";
import { formatError } from "./discord.js";
import { handleGeneral } from "./handlers/general.js";
import { handleInsightsUI } from "./handlers/insights-ui.js";
import { handleOutreachData } from "./handlers/outreach-data.js";
import { startJobScheduler } from "./jobs/jobs.js";

let activeJobs = 0;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown"}`);
  void startJobScheduler(client);
});

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const afterPrefix = message.content.slice(PREFIX.length);
  if (afterPrefix.length > 0 && afterPrefix[0] !== " ") return;

  const prompt = afterPrefix.trim();

  if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(message.channelId)) return;

  if (ALLOWED_USERS && !ALLOWED_USERS.includes(message.author.id)) {
    await message.reply("You are not authorized to use this bot.");
    return;
  }

  if (!prompt) {
    await message.reply(`Please provide a prompt after \`${PREFIX}\`.`);
    return;
  }

  if (activeJobs >= MAX_CONCURRENT) {
    await message.reply("Too many requests in progress. Please wait and try again.");
    return;
  }

  activeJobs++;

  try {
    if (message.channelId === INSIGHTS_UI_CHANNEL) {
      await handleInsightsUI(message, prompt);
    } else if (message.channelId === OUTREACH_DATA_CHANNEL) {
      await handleOutreachData(message, prompt);
    } else {
      await handleGeneral(message, prompt);
    }
  } catch (err) {
    await message.reply(`Error: ${formatError(err)}`);
  } finally {
    activeJobs--;
  }
});

client.login(DISCORD_TOKEN);
