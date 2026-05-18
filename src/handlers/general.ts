import type { Message } from "discord.js";
import { runClaude } from "../claude.js";
import { replyInChunks, truncateForPreview } from "../discord.js";

export async function handleGeneral(message: Message, prompt: string): Promise<void> {
  await message.reply("Working on it...");
  const output = await runClaude(prompt, {
    sessionKey: message.channelId,
    sessionMeta: {
      userId: message.author.id,
      description: "general",
      promptPreview: truncateForPreview(prompt, 80),
    },
  });
  await replyInChunks(message, output);
}
