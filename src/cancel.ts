import { cancelSessionsForKey, listSessionsForKey, type ActiveClaudeSession } from "./claude-sessions.js";

export interface CancelOutcome {
  cancelled: ActiveClaudeSession[];
  message: string;
}

function formatSessionSummary(s: ActiveClaudeSession): string {
  const elapsedSec = Math.max(0, Math.round((Date.now() - s.startedAt) / 1000));
  const preview = s.promptPreview ? ` — "${s.promptPreview}"` : "";
  return `- \`${s.description}\` (running ${String(elapsedSec)}s)${preview}`;
}

// Cancel every active Claude session registered under sessionKey (typically a
// channel or thread id). Returns the killed sessions plus a Discord-ready
// message describing what happened.
export function cancelSessionsAndReport(sessionKey: string): CancelOutcome {
  const before = listSessionsForKey(sessionKey);
  if (before.length === 0) {
    return { cancelled: [], message: "No active Claude session in this channel/thread to cancel." };
  }
  const cancelled = cancelSessionsForKey(sessionKey);
  const lines = [
    `Cancelled ${String(cancelled.length)} Claude session${cancelled.length === 1 ? "" : "s"} in this channel/thread:`,
    ...cancelled.map(formatSessionSummary),
  ];
  return { cancelled, message: lines.join("\n") };
}
