import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Message } from "discord.js";
import { GEMINI_TRANSCRIBE_MODEL, GOOGLE_API_KEY } from "./config.js";

const AUDIO_DIR = join(tmpdir(), "discord-bot-audio");
const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|wav|m4a|mp4|aac|flac|webm)$/i;

const TRANSCRIPTION_PROMPT =
  "Transcribe the spoken content of the attached audio verbatim. Do not summarize, translate, or add commentary. " +
  "Return ONLY the transcription text — no quotes, no markdown, no preamble. " +
  "If the audio is silent or unintelligible, return the single token (inaudible).";

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

function mimeTypeForAttachment(attachment: Attachment): string {
  const ct = attachment.contentType?.split(";")[0].trim().toLowerCase();
  if (ct?.startsWith("audio/")) return ct;
  const name = attachment.name?.toLowerCase() ?? "";
  if (/\.(ogg|oga|opus)$/.test(name)) return "audio/ogg";
  if (/\.mp3$/.test(name)) return "audio/mp3";
  if (/\.wav$/.test(name)) return "audio/wav";
  if (/\.m4a$/.test(name) || /\.mp4$/.test(name) || /\.aac$/.test(name)) return "audio/aac";
  if (/\.flac$/.test(name)) return "audio/flac";
  if (/\.webm$/.test(name)) return "audio/webm";
  return "audio/ogg";
}

interface GeminiTextPart {
  text: string;
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiTextPart[] } }[];
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
}

async function transcribeWithGemini(audioBase64: string, mimeType: string): Promise<string> {
  if (!GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is not set — cannot transcribe audio.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_TRANSCRIBE_MODEL)}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const body = {
    contents: [
      {
        parts: [{ text: TRANSCRIPTION_PROMPT }, { inline_data: { mime_type: mimeType, data: audioBase64 } }],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(raw) as GeminiResponse;
  } catch {
    throw new Error(`Gemini API returned non-JSON response (HTTP ${res.status}): ${raw.slice(0, 300)}`);
  }

  if (!res.ok) {
    const msg = parsed.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }

  if (parsed.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${parsed.promptFeedback.blockReason}`);
  }

  const text = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return text.trim();
}

async function transcribeFile(audioPath: string, mimeType: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const buf = readFileSync(audioPath);
  return transcribeWithGemini(buf.toString("base64"), mimeType);
}

export async function transcribeAttachments(attachments: Attachment[]): Promise<string> {
  const parts: string[] = [];
  for (const att of attachments) {
    const path = await downloadAttachment(att);
    const mimeType = mimeTypeForAttachment(att);
    try {
      const text = await transcribeFile(path, mimeType);
      parts.push(text || "(empty transcript)");
    } finally {
      cleanupAudioFile(path);
    }
  }
  return parts.join("\n\n").trim();
}
