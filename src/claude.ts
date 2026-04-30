import { execFile } from "child_process";
import { CLAUDE_TIMEOUT, MAX_BUFFER } from "./config.js";

export interface ClaudeOptions {
  cwd?: string;
  continueSession?: boolean;
}

export class ClaudeRateLimitError extends Error {
  constructor(
    message: string,
    public readonly detail: string,
  ) {
    super(message);
    this.name = "ClaudeRateLimitError";
  }
}

// Phrases the Claude Code CLI uses when the account-level usage limit
// (hourly/5-hour/weekly) has been reached. Matched case-insensitively against
// the combined stdout+stderr of the subprocess.
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /claude(?:\s+ai)?\s+usage\s+limit\s+reached/i,
  /usage\s+limit\s+reached/i,
  /\brate\s*limit(?:ed)?\b/i,
  /5-?hour\s+(?:usage\s+)?limit/i,
  /weekly\s+(?:usage\s+)?limit/i,
];

// The Claude CLI prints this warning to stderr when stdin stays open without
// any data. We close stdin on the child so it should never fire, but we also
// strip it defensively in case it does — surfacing it to users is confusing.
const STDIN_WARNING_PATTERNS: RegExp[] = [/no stdin data received/i, /redirect stdin explicitly/i];

function stripStdinWarning(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .filter((line) => !STDIN_WARNING_PATTERNS.some((p) => p.test(line)))
    .join("\n")
    .trim();
}

function extractRateLimitDetail(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const matched = RATE_LIMIT_PATTERNS.some((p) => p.test(combined));
  if (!matched) return null;

  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const matchedLines = lines.filter((line) => RATE_LIMIT_PATTERNS.some((p) => p.test(line)));
  return matchedLines.length > 0 ? matchedLines.join("\n") : combined.trim();
}

export function runClaude(prompt: string, options: ClaudeOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--dangerously-skip-permissions", "--output-format", "text"];
    if (options.continueSession) args.unshift("-c");
    args.push(prompt);
    const opts: { timeout: number; maxBuffer: number; cwd?: string } = {
      timeout: CLAUDE_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    };
    if (options.cwd) opts.cwd = options.cwd;

    const child = execFile("claude", args, opts, (error, stdout, stderr) => {
      if (error) {
        const detail = extractRateLimitDetail(stdout, stderr);
        if (detail !== null) {
          reject(new ClaudeRateLimitError(`Claude Code usage limit reached. ${detail}`, detail));
          return;
        }
        const cleanedStderr = stripStdinWarning(stderr);
        const cleanedStdout = stdout.trim();
        const combined = [cleanedStderr, cleanedStdout, error.message].filter((s) => s && s.length > 0).join("\n");
        reject(new Error(combined || error.message));
        return;
      }

      const detail = extractRateLimitDetail(stdout, "");
      if (detail !== null) {
        reject(new ClaudeRateLimitError(`Claude Code usage limit reached. ${detail}`, detail));
        return;
      }
      resolve(stdout.trim() || "(no output)");
    });

    // Close stdin immediately: we only use the -p prompt arg, so Claude should
    // not wait for input. Without this, the CLI emits a "no stdin data
    // received in 3s" warning to stderr and blocks the call for ~3 seconds.
    child.stdin?.end();
  });
}
