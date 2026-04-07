import type { Message } from "discord.js";
import { runClaude } from "../claude.js";
import { replyInChunks } from "../discord.js";

export async function handleGeneral(message: Message, prompt: string): Promise<void> {
  await message.reply("Working on it...");
  const output = await runClaude(prompt);
  await replyInChunks(message, output);
}
