# Knowledge Base Index

This folder collects durable, reference-style knowledge about the discord-claude-bot codebase — patterns, subsystem walkthroughs, and "how X actually works" notes that are too detailed for `CLAUDE.md` but still worth keeping checked in.

`CLAUDE.md` stays focused on high-level project overview and quick-reference rules. The knowledge base is where the long-form explanations live.

## How to use this index

1. Before starting non-trivial work on a subsystem, skim the relevant knowledge file.
2. When you learn something non-obvious about how a part of the system works (a subtle invariant, a multi-step flow, a "why this way and not the obvious way"), add or update a file here.
3. Keep each file focused on a single topic. Split rather than grow a file past a few screens.
4. Update this index whenever a file is added, renamed, or removed.

## Files

### Discord integration
- [discord-slash-commands.md](discord-slash-commands.md) — How `/compact`, `/list-worktrees`, and `/delete-worktree` are defined, registered with Discord, and dispatched at runtime. Includes the step-by-step recipe for adding a new slash command.

### Claude CLI integration
- [claude-subprocess-errors.md](claude-subprocess-errors.md) — How `runClaude` invokes the Claude CLI, why stdin is closed immediately, how rate-limit errors are detected (`ClaudeRateLimitError`), and how `formatClaudeError` surfaces them to users.
