import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Bot-managed effort override stored OUTSIDE Claude Code's settings.json.
// Claude Code's settings schema rejects "max" — it's only valid as a CLI flag
// for the current session — so we keep it here and pass it via --effort when
// spawning the subprocess.
function overridePath(): string {
  return process.env.CLAUDE_BOT_EFFORT_OVERRIDE_PATH ?? join(process.env.HOME ?? "/home/ubuntu", ".claude", "discord-bot-effort-override.txt");
}

export function readEffortOverride(): string | null {
  const p = overridePath();
  if (!existsSync(p)) return null;
  try {
    const value = readFileSync(p, "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeEffortOverride(level: string): string {
  const p = overridePath();
  writeFileSync(p, `${level}\n`, "utf-8");
  return p;
}

export function clearEffortOverride(): string {
  const p = overridePath();
  if (existsSync(p)) unlinkSync(p);
  return p;
}

export function getEffortOverridePath(): string {
  return overridePath();
}
