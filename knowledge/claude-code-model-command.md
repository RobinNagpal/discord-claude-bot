# `/claude-code-model` Slash Command

Lets a Discord user switch the default Claude Code model that future sessions will use. Mirrors the `/claude-code-effort` pattern.

## What it does

1. Reads `~/.claude/settings.json` via `readClaudeSettings()` (shared helper already used by the effort command).
2. Updates (or deletes) the `model` key based on the user's choice.
3. Writes the settings back as pretty-printed JSON with a trailing newline.
4. Replies with the before/after values, the path that was written, and a warning if `ANTHROPIC_MODEL` is set in the bot's environment (that env var overrides `settings.json`).

The handler lives in `src/slash-commands.ts` as `handleClaudeCodeModel()`.

## Choices

The command offers four fixed choices via `addChoices(...)`:

| Choice     | Effect                                                                            |
| ---------- | --------------------------------------------------------------------------------- |
| `opus`     | Writes `"model": "opus"` to `settings.json`.                                      |
| `sonnet`   | Writes `"model": "sonnet"` to `settings.json`.                                    |
| `haiku`    | Writes `"model": "haiku"` to `settings.json`.                                     |
| `default`  | Deletes the `model` key — Claude Code falls back to its built-in default.         |

These are aliases that Claude Code's CLI and settings resolver accept (same names as `claude --model <model>`). `default` is a sentinel we invented to express "clear the override"; Claude Code itself doesn't have a `"default"` value.

## Precedence

Claude Code resolves the default model in this order:

1. `--model <x>` CLI flag (session-only, not touched by this command).
2. `ANTHROPIC_MODEL` env var (warned about if set; not cleared by this command).
3. `model` key in `~/.claude/settings.json` (this is what the command writes).
4. Claude Code's built-in default.

So `/claude-code-model` changes layer 3. If layer 2 is set in the bot's environment, the user sees a warning because their change won't take effect until the env var is unset.

## Scope

- **Any channel or thread.** No `resolveProjectContext` / worktree check — the setting is global to the machine running the bot.
- **Takes effect on the next Claude Code session** the bot spawns. Currently running sessions keep their old model until they end.
- **Does not restart the bot.** Pair with `/pull-bot-and-restart` if you need the bot to pick up a matching env change.

## Implementation pointers

- Builder: in the `commands` array in `src/slash-commands.ts`, using `.addStringOption(...).addChoices(...)`.
- Handler: `handleClaudeCodeModel()` — validates the choice against `MODEL_CHOICES`, defers, reads/writes settings, reports via `interaction.editReply()`.
- Dispatch: `handleInteraction()` has a single `else if (interaction.commandName === "claude-code-model")` branch.
- Reuses the `ClaudeSettings` interface and `readClaudeSettings()` helper that the effort command already uses — the only structural change was adding `model?: string` to the interface.

## Gotchas

- The settings.json write is **non-atomic** (plain `writeFileSync`). If two writes race (e.g. effort + model at the same time) one could clobber the other. In practice the commands are rarely invoked concurrently so we haven't added locking.
- The `ANTHROPIC_MODEL` warning is informational only — we don't try to mutate `process.env` or the systemd unit file.
- Keep the `MODEL_CHOICES` list and the builder's `.addChoices(...)` list in sync; Discord validates the incoming value against the builder choices, but the handler re-checks defensively.
