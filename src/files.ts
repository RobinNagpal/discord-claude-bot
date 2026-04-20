import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Message } from "discord.js";
import { isAudioAttachment } from "./audio.js";

const FILES_DIR = join(tmpdir(), "discord-bot-files");
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_INLINE_TEXT_SIZE = 512 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "rst",
  "csv",
  "tsv",
  "log",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "swift",
  "scala",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "env",
  "gitignore",
  "prettierrc",
  "eslintrc",
  "sql",
  "graphql",
  "gql",
  "proto",
  "dockerfile",
  "patch",
  "diff",
]);

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
  "application/sql",
  "application/toml",
]);

export interface DownloadedFile {
  name: string;
  path: string;
  size: number;
  contentType: string | null;
  /** UTF-8 content when the attachment is text and small enough to inline; null for binary or oversize. */
  text: string | null;
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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isTextAttachment(att: Attachment): boolean {
  const ct = att.contentType?.split(";")[0].trim().toLowerCase() ?? "";
  if (ct) {
    if (TEXT_MIME_PREFIXES.some((p) => ct.startsWith(p))) return true;
    if (TEXT_MIME_EXACT.has(ct)) return true;
  }
  const name = att.name?.toLowerCase() ?? "";
  if (!name) return false;
  const ext = extensionOf(name);
  return TEXT_EXTENSIONS.has(ext);
}

function looksLikeBinary(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
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
    let text: string | null = null;
    if (isTextAttachment(att) && buf.length <= MAX_INLINE_TEXT_SIZE && !looksLikeBinary(buf)) {
      text = buf.toString("utf-8");
    }
    downloaded.push({ name, path: dest, size: buf.length, contentType: att.contentType ?? null, text });
  }
  return downloaded;
}

export function formatAttachedFilesSection(files: DownloadedFile[]): string {
  if (files.length === 0) return "";

  const sections: string[] = [];

  const inlined = files.filter((f) => f.text !== null);
  if (inlined.length > 0) {
    const blocks = inlined.map((f) => {
      const typeNote = f.contentType ? `, ${f.contentType}` : "";
      const content = f.text ?? "";
      return `===== BEGIN FILE: ${f.name} (${formatFileSize(f.size)}${typeNote}) =====\n${content}\n===== END FILE: ${f.name} =====`;
    });
    sections.push(
      `The user attached the following text file(s). Treat the content between the BEGIN/END markers as part of the user's message.\n\n${blocks.join("\n\n")}`,
    );
  }

  const referenced = files.filter((f) => f.text === null);
  if (referenced.length > 0) {
    const lines = referenced.map((f) => {
      const typeNote = f.contentType ? `, ${f.contentType}` : "";
      return `- ${f.name} — ${f.path} (${formatFileSize(f.size)}${typeNote})`;
    });
    sections.push(
      `The user attached the following non-text or oversized file(s), saved locally — use the Read tool at these absolute paths to inspect them:\n${lines.join("\n")}`,
    );
  }

  return sections.join("\n\n");
}
