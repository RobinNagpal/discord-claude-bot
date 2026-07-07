# Claude Code `settings.json` — Reference

The bot spawns the Claude Code CLI as a subprocess (see
[`claude-subprocess-errors.md`](claude-subprocess-errors.md)). Every session it starts is
shaped by the same `settings.json` files documented here. This note is the reference for
"where does that setting live, and who wins when two files disagree." For the specific
`/claude-code-model` slash command that edits `~/.claude/settings.json`, see
[`claude-code-model-command.md`](claude-code-model-command.md).

> Source: <https://code.claude.com/docs/en/settings> (fetched 2026-07-07). Claude Code
> evolves quickly — treat the key list as a snapshot and re-check the live docs before
> relying on an obscure key.

## What the bot's host actually has today

The machine running the bot has this `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["WebSearch", "WebFetch"]
  },
  "effortLevel": "xhigh",
  "skipDangerousModePermissionPrompt": true,
  "model": "opus"
}
```

- `permissions.allow` pre-approves the `WebSearch` / `WebFetch` tools so subprocess sessions
  never block on a permission prompt for them.
- `effortLevel` and `model` are the two keys the bot's slash commands (`/claude-code-effort`,
  `/claude-code-model`) read and write via the shared `readClaudeSettings()` helper.
- `skipDangerousModePermissionPrompt` matters because every handler invokes the CLI with
  `--dangerously-skip-permissions` (see `src/claude.ts`); this flag stops the one-time
  "are you sure?" confirmation from ever appearing non-interactively.

There is also an empty `~/.claude/settings.local.json` (the gitignored per-user layer).

## File hierarchy & precedence

Claude Code merges settings from several files. **Highest priority wins** for a scalar key;
permission rules are the exception (see below). Order, highest → lowest:

1. **Managed / enterprise policy** — deployed by an admin, cannot be overridden by users.
   - Linux/WSL: `/etc/claude-code/managed-settings.json` (+ `managed-settings.d/` drop-ins)
   - macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
   - Windows: `C:\Program Files\ClaudeCode\managed-settings.json`
2. **Command-line arguments** — session-only overrides (e.g. `--model`).
3. **Local project** — `.claude/settings.local.json` (gitignored, per-user, per-repo).
4. **Project** — `.claude/settings.json` (committed, shared with the team).
5. **User** — `~/.claude/settings.json` (applies to every project on the machine). **This is
   the file the bot uses**, because its sessions run in many different worktrees and it wants
   one machine-wide default.

Conflict resolution:

- **Scalar keys** (`model`, `effortLevel`, `outputStyle`, …): the highest-priority file that
  sets the key wins; lower files are ignored for that key.
- **`permissions` rules**: `allow` / `ask` / `deny` lists are **merged (union)** across all
  scopes, not overridden. A `deny` anywhere blocks the action.

Add `"$schema": "https://json.schemastore.org/claude-code-settings.json"` to a settings file
for editor autocomplete. Claude Code keeps timestamped backups (5 most recent) of config files.

## Keys most relevant to this bot

| Key | Type | Meaning |
| --- | --- | --- |
| `model` | string | Default model (e.g. `"opus"`, `"sonnet"`, `"haiku"`, or a full model ID). Read at startup; `/model` switches mid-session. |
| `effortLevel` | `"low"｜"medium"｜"high"｜"xhigh"` | Persisted reasoning effort. |
| `permissions` | object | `allow` / `ask` / `deny` / `additionalDirectories` / `defaultMode` / `disableBypassPermissionsMode`. |
| `env` | object | Env vars injected into every session **and** every subprocess it spawns. |
| `hooks` | object | Lifecycle event handlers (PreToolUse, PostToolUse, Stop, …). |
| `apiKeyHelper` | string | Shell command that prints an auth token. |
| `statusLine` | string | Custom status-line command. |
| `cleanupPeriodDays` | number | Age (default 30) after which session transcripts are deleted. |
| `includeCoAuthoredBy` | boolean | Whether commits/PRs get the `Co-Authored-By: Claude` trailer. |
| `enableAllProjectMcpServers` | boolean | Auto-approve every server in a project `.mcp.json`. |
| `enabledMcpjsonServers` / `disabledMcpjsonServers` | string[] | Approve / reject specific `.mcp.json` servers by name. |

`model` and `effortLevel` are the two the bot itself mutates. The rest are here so future
work (e.g. adding hooks or an MCP server) knows which key to reach for.

## The `permissions` object

```json
{
  "permissions": {
    "allow": ["Bash(npm run lint)", "Read(~/.zshrc)", "WebSearch"],
    "ask":   ["Write(src/**)"],
    "deny":  ["Bash(curl *)", "Read(./.env)", "Read(./secrets/**)"],
    "additionalDirectories": ["/custom/path"],
    "defaultMode": "ask",
    "disableBypassPermissionsMode": false
  }
}
```

- **`allow`** — patterns auto-approved (no prompt).
- **`ask`** — patterns that always prompt first.
- **`deny`** — patterns always blocked; wins over `allow`.
- **`additionalDirectories`** — extra dirs the session may read/write outside the project root.
- **`defaultMode`** — `"ask"` or `"allow"` for anything not matched above.
- **`disableBypassPermissionsMode`** — stops a user toggling the bypass mode.

Rule syntax is `Tool(pattern)` — e.g. `Bash(npm run test *)`, `Read(./.env.*)`, or a bare
tool name like `WebSearch`. Note the bot sidesteps all of this at runtime with
`--dangerously-skip-permissions`, so these rules only bite in interactive sessions.

## Environment variables

Two ways to set env: the `env` key in a settings file, or the real process environment.
Notable ones Claude Code reads:

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_MODEL` | Overrides `model` for the session. **Takes precedence over `settings.json`** — this is exactly why `/claude-code-model` warns when it is set (see the model-command note). |
| `CLAUDE_CODE_EFFORT_LEVEL` | Overrides `effortLevel` for the session. |
| `ANTHROPIC_API_KEY` | API key for direct-console auth. |
| `DISABLE_AUTOUPDATER` | Turn off auto-update. |
| `DISABLE_AUTO_COMPACT` | Turn off near-limit auto-compaction. |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `0` / `1` telemetry toggle. |
| `MAX_THINKING_TOKENS` | `0` disables extended thinking. |

Precedence for the model specifically (from most to least authoritative):
`--model` flag → `ANTHROPIC_MODEL` env → `model` in `settings.json` → built-in default.

## Hooks (brief)

`hooks` maps a lifecycle event to matcher/command entries. Shape:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./scripts/guard.sh" }]
      }
    ]
  }
}
```

Common events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`,
`Notification`, `SessionStart`. Hooks are how you enforce automatic behaviors that the model
can't be trusted to remember (formatting after every edit, blocking a command, etc.). The bot
does not use hooks today; this is a pointer for when it needs deterministic policy.

## Gotchas

- **User-scope, not project-scope.** Because the bot runs sessions across many worktrees, its
  durable config lives in `~/.claude/settings.json`, not a committed `.claude/settings.json`.
  Editing a repo's project settings would only affect sessions whose cwd is inside that repo.
- **Writes are non-atomic.** The slash-command handlers do a plain `writeFileSync`; concurrent
  edits (effort + model at once) can clobber each other. See the model-command note.
- **`ANTHROPIC_MODEL` silently overrides the file.** If the bot's systemd env sets it, no
  amount of editing `settings.json` changes the model until the env var is cleared.
- **`--dangerously-skip-permissions` bypasses the `permissions` block** for the bot's own
  subprocess calls, so don't rely on `deny` rules for runtime safety in that path.
