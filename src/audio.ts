import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Message } from "discord.js";
import { runClaude } from "./claude.js";
import { readResultFile } from "./result.js";

const AUDIO_DIR = join(tmpdir(), "discord-bot-audio");
const TRANSCRIPT_RESULT = "/tmp/claude-code-audio-transcript.md";
const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|wav|m4a|mp4|aac|flac|webm)$/i;

export function isAudioAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  if (contentType.startsWith("audio/")) return true;
  const name = attachment.name?.toLowerCase() ?? "";
  return AUDIO_EXT_RE.test(name);
}

export function getAudioAttachments(message: Message): Attachment[] {
  const list: Attachment[] = [];
  for (const att of message.attachments.values()) {
    if (isAudioAttachment(att)) list.push(att);
  }
  return list;
}

async function downloadAttachment(attachment: Attachment): Promise<string> {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const rawName = attachment.name ?? `audio-${attachment.id}`;
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = join(AUDIO_DIR, `${attachment.id}-${safeName}`);
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Failed to download audio (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

function cleanupAudioFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // ignore
  }
}

function buildTranscriptionPrompt(audioPath: string): string {
  return `You are a transcription service. An audio file is at this absolute path:

${audioPath}

Transcribe the spoken content verbatim. Do not summarize, translate, or add commentary.

Write ONLY the transcription text to this file — no quotes, no markdown, no preamble, no trailing notes:

${TRANSCRIPT_RESULT}

If the audio is silent or unintelligible, write the single token (inaudible) to the file instead. If the file cannot be opened or the format is unsupported, write a single line describing the error.`;
}

async function transcribeFile(audioPath: string): Promise<string> {
  try {
    rmSync(TRANSCRIPT_RESULT, { force: true });
  } catch {
    // ignore
  }
  await runClaude(buildTranscriptionPrompt(audioPath));
  return readResultFile(TRANSCRIPT_RESULT).trim();
}

export async function transcribeAttachments(attachments: Attachment[]): Promise<string> {
  const parts: string[] = [];
  for (const att of attachments) {
    const path = await downloadAttachment(att);
    try {
      const text = await transcribeFile(path);
      parts.push(text || "(empty transcript)");
    } finally {
      cleanupAudioFile(path);
    }
  }
  return parts.join("\n\n").trim();
}
