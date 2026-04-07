import fs from "fs";

export function readResultFile(path: string): string {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return "(Could not read result file)";
  }
}

export function extractField(text: string, regex: RegExp): string | null {
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}
