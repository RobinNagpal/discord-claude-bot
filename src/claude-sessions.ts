import type { ChildProcess } from "node:child_process";

export interface ActiveClaudeSession {
  id: string;
  sessionKey: string;
  child: ChildProcess;
  startedAt: number;
  userId: string;
  description: string;
  promptPreview: string;
  cancelled: boolean;
}

const sessionsByKey = new Map<string, Set<ActiveClaudeSession>>();
let nextId = 1;

export interface NewSessionInput {
  sessionKey: string;
  child: ChildProcess;
  userId: string;
  description: string;
  promptPreview: string;
}

export function registerSession(input: NewSessionInput): ActiveClaudeSession {
  const session: ActiveClaudeSession = {
    id: String(nextId++),
    sessionKey: input.sessionKey,
    child: input.child,
    startedAt: Date.now(),
    userId: input.userId,
    description: input.description,
    promptPreview: input.promptPreview,
    cancelled: false,
  };
  let set = sessionsByKey.get(session.sessionKey);
  if (!set) {
    set = new Set();
    sessionsByKey.set(session.sessionKey, set);
  }
  set.add(session);
  return session;
}

export function unregisterSession(session: ActiveClaudeSession): void {
  const set = sessionsByKey.get(session.sessionKey);
  if (!set) return;
  set.delete(session);
  if (set.size === 0) sessionsByKey.delete(session.sessionKey);
}

export function listSessionsForKey(sessionKey: string): ActiveClaudeSession[] {
  const set = sessionsByKey.get(sessionKey);
  return set ? [...set] : [];
}

// SIGTERM gives Claude a chance to clean up; SIGKILL is the belt-and-suspenders
// fallback if the subprocess ignores the polite shutdown signal.
const FORCE_KILL_DELAY_MS = 2000;

export function cancelSessionsForKey(sessionKey: string): ActiveClaudeSession[] {
  const set = sessionsByKey.get(sessionKey);
  if (!set || set.size === 0) return [];
  const cancelled: ActiveClaudeSession[] = [];
  for (const session of [...set]) {
    session.cancelled = true;
    try {
      if (session.child.pid !== undefined && !session.child.killed) {
        session.child.kill("SIGTERM");
        setTimeout(() => {
          if (!session.child.killed) {
            try {
              session.child.kill("SIGKILL");
            } catch {
              // best-effort
            }
          }
        }, FORCE_KILL_DELAY_MS);
      }
    } catch {
      // best-effort
    }
    cancelled.push(session);
  }
  return cancelled;
}
