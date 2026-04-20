import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Message } from "discord.js";
import { isAudioAttachment } from "./audio.js";

const FILES_DIR = join(tmpdir(), "discord-bot-files");
const MAX_FILE_SIZE = 25 * 1024 * 1024;

export interface DownloadedFile {
  name: string;
  path: string;
  size: number;
  contentType: string | null;
}

export function getNonAudioAttachments(message: Message): Attachment[] {
  const list: Attachment[] = [];
  for (const att of message.attachments.values()) {
    if (!isAudioAttachment(att)) list.push(att);
  }
  return list;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function downloadFilesForMessage(messageId: string, attachments: Attachment[]): Promise<DownloadedFile[]> {
  if (attachments.length === 0) return [];
  const dir = join(FILES_DIR, messageId);
  mkdirSync(dir, { recursive: true });
  const downloaded: DownloadedFile[] = [];
  for (const att of attachments) {
    if (att.size > MAX_FILE_SIZE) {
      throw new Error(`Attachment ${att.name ?? att.id} is ${formatFileSize(att.size)}, exceeds the ${formatFileSize(MAX_FILE_SIZE)} limit.`);
    }
    const name = sanitizeFilename(att.name ?? `file-${att.id}`);
    const dest = join(dir, name);
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Failed to download ${name} (HTTP ${String(res.status)})`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    downloaded.push({ name, path: dest, size: buf.length, contentType: att.contentType ?? null });
  }
  return downloaded;
}

export function formatAttachedFilesSection(files: DownloadedFile[]): string {
  if (files.length === 0) return "";
  const lines = files.map((f) => {
    const typeNote = f.contentType ? `, ${f.contentType}` : "";
    return `- ${f.name} — ${f.path} (${formatFileSize(f.size)}${typeNote})`;
  });
  return `Attached files (downloaded from Discord — use the Read tool at these absolute paths to inspect them):\n${lines.join("\n")}`;
}
