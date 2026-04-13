import type { Message, ThreadChannel } from "discord.js";

const MAX_DISCORD_LENGTH = 1900;

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = MAX_DISCORD_LENGTH;

    const lastNewline = remaining.lastIndexOf("\n", splitAt);
    if (lastNewline > splitAt * 0.5) {
      splitAt = lastNewline + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(" ", splitAt);
      if (lastSpace > splitAt * 0.5) {
        splitAt = lastSpace + 1;
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

export async function replyInChunks(message: Message, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await message.reply(chunk);
  }
}

export async function sendInChunks(thread: ThreadChannel, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await thread.send(chunk);
  }
}

export function formatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 500);
}
