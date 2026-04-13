import { execFile } from "child_process";
import { CLAUDE_TIMEOUT, MAX_BUFFER } from "./config.js";

export interface ClaudeOptions {
  cwd?: string;
  continueSession?: boolean;
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

    execFile("claude", args, opts, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim() || "(no output)");
      }
    });
  });
}
