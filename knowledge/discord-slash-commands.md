# Discord Slash Commands

How the bot defines, registers, and dispatches Discord slash commands — and how to add a new one.

> Scope: this file covers Discord **slash commands** (the `/foo` commands that appear in Discord's autocomplete UI after typing `/`). It does NOT cover the `!claude <prompt>` message-prefix flow, which is separate and lives in `src/bot.ts` + `src/handlers/`.

## Where everything lives

- **`src/slash-commands.ts`** — single module that owns:
  - the array of `SlashCommandBuilder` definitions,
  - `registerSlashCommands()` which PUTs them to Discord's REST API,
  - one `handleXxx()` function per command,
  - `handleInteraction()` which dispatches incoming interactions by `commandName`.
- **`src/bot.ts`** — wires everything in:
  - calls `registerSlashCommands()` from the `ready` event,
  - forwards every `ChatInputCommand` interaction to `handleInteraction()` via `client.on("interactionCreate", ...)`.

Currently defined commands (all implemented in `src/slash-commands.ts`):

| Command                  | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `/compact`               | Compact the Claude session for the current worktree thread.        |
| `/list-worktrees`        | List git worktrees for the channel's project.                      |
| `/delete-worktree`       | Remove a worktree and its branch (with a `name` string option).    |
| `/claude-code-usage`     | Report Claude Code subscription usage for the current session and rolling week. Runs in any channel/thread. |
| `/pull-bot-and-restart`  | Fetch latest `main` into the deployment repo, rebuild, and restart the systemd service. Gated by `ALLOWED_USERS`. |

## Registration lifecycle

Slash commands must be registered with Discord's REST API before they appear in the client. The bot does this on every startup:

1. **`ready` event fires** (`src/bot.ts`): the client has logged in and cached guilds.
2. **`registerSlashCommands()` runs** (`src/slash-commands.ts`):
   - Builds the payload: `commands.map((c) => c.toJSON())`.
   - If `DISCORD_GUILD_ID` is set in the env, it calls `Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID)` — guild commands are **instant** for that guild, which is what we use in dev and in the target server.
   - If `DISCORD_GUILD_ID` is not set, it falls back to `Routes.applicationCommands(DISCORD_APP_ID)` — global commands are visible in every server the bot is in, but Discord can take up to ~1 hour to propagate them.
   - Uses `rest.put(...)` — this is an **overwriting** operation. Whatever array is sent becomes the full set of commands. Commands removed from the local array disappear on next startup.
3. **Failures are logged, not thrown.** A failed registration will print a hint about re-inviting with `scope=bot+applications.commands` and then the bot keeps running. Existing message handlers still work; only the slash UI will be stale.

### Required env

- `DISCORD_APP_ID` — the application ID (required). See `CLAUDE.md` for the real value.
- `DISCORD_TOKEN` — the bot token (required; used as Bearer for the REST client).
- `DISCORD_GUILD_ID` — optional. Set it to register per-guild (instant); leave unset for global (slow propagation). Almost always set for this bot.

### Required OAuth scopes

The bot must be invited with both `bot` and `applications.commands` scopes. The invite URL in `CLAUDE.md` already includes them. If a user only invites with `bot`, registration fails with a "Missing Access" 403 — the error message in `registerSlashCommands()` explicitly points at this.

## Dispatch at runtime

In `src/bot.ts`:

```ts
client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleInteraction(interaction);
  } catch (err) {
    // Reports error via editReply or ephemeral reply depending on interaction state
  }
});
```

`handleInteraction()` is a simple command-name switch:

```ts
export async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "compact") await handleCompact(interaction);
  else if (interaction.commandName === "list-worktrees") await handleListWorktrees(interaction);
  else if (interaction.commandName === "delete-worktree") await handleDeleteWorktree(interaction);
}
```

No registry map, no decorators — it's just an if/else ladder. Keep it that way until we have enough commands that it genuinely hurts.

## The three-second deadline and `deferReply`

Discord requires the bot to respond to an interaction within **3 seconds** or it's marked as failed in the client. Most of our handlers do real work (spawning `claude`, running `git`, removing worktrees) that takes longer. The pattern:

1. **Fast rejects first** — validate the channel/thread and argument shape, then send a quick `interaction.reply({ ..., flags: MessageFlags.Ephemeral })` for obvious user errors (wrong channel, bad input). These complete well under 3s.
2. **Slow work goes after `deferReply()`** — once we know we're going to do real work, call `await interaction.deferReply();`. This tells Discord "I'm thinking," shows a spinner in the client, and gives us up to 15 minutes to produce the real reply via `interaction.editReply()` or `interaction.followUp()`.
3. **Long output uses `sendLong()`** — helper in `slash-commands.ts` that splits at Discord's 2000-char message limit using `splitMessage()` from `src/discord.ts`: first chunk via `editReply`, subsequent chunks via `followUp`.

The two reply styles you'll see:
- `interaction.reply({ content: "...", flags: MessageFlags.Ephemeral })` — user sees it, nobody else does. Used for validation errors that aren't interesting to the rest of the channel.
- `interaction.deferReply()` then `editReply(...)` — public reply, visible to everyone. Used for the actual command output.

## Channel/thread context

Most of our commands only make sense in a specific project channel or one of its threads. The two helpers in `slash-commands.ts`:

- **`resolveWorktreePath(parentId, threadName)`** — used by `/compact`. Takes a thread's parent channel id and maps it to the right worktree base; returns `join(base, threadName)` or `null` if the parent isn't a known project channel.
- **`resolveProjectContext(interaction)`** — used by `/list-worktrees` and `/delete-worktree`. Walks channel -> parent (for threads) -> project config, returning `{ mainRepo, worktreeBase, projectName }` or `null`. This lets the command work in both the channel itself (`#insights-ui`) AND in any of its threads.

If `resolve*` returns `null`, reply with an ephemeral "this command must be run in …" and stop. Don't `defer`.

## Adding a new slash command — the recipe

1. **Define the builder** in the `commands` array at the top of `src/slash-commands.ts`. Pick a kebab-case name and write a one-line description (shown in Discord's UI):

   ```ts
   new SlashCommandBuilder()
     .setName("my-command")
     .setDescription("One sentence describing what this does.")
     .addStringOption((opt) => opt.setName("name").setDescription("...").setRequired(true)),
   ```

   Use `.addStringOption`, `.addIntegerOption`, `.addUserOption`, etc. for parameters. Each option needs a name, description, and whether it's required.

2. **Write the handler** — an `async function handleMyCommand(interaction: ChatInputCommandInteraction): Promise<void>`. Follow the pattern:
   - Validate channel/thread context early; ephemeral reply + return on failure.
   - Validate and sanitise user-provided string options (see `validateWorktreeName()` — block `-` prefixes, `..`, null bytes when the string will be used in a shell/path).
   - `await interaction.deferReply();` before the slow work.
   - Do the work, catch errors, and report via `interaction.editReply(...)` — never let an exception propagate out uncaught (the top-level handler does report errors, but always prefer to report within the handler so the user sees a useful message).
   - Use `sendLong()` for any reply that might exceed 2000 chars.

3. **Wire it into `handleInteraction`** — add an `else if (interaction.commandName === "my-command")` branch.

4. **(Optional) Add permissions or restrictions** — if the command is destructive or admin-only, either check `interaction.memberPermissions` inside the handler, or chain `.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` on the builder.

5. **Restart the bot.** Registration happens on `ready`; new commands are pushed to Discord automatically. No manual CLI step.

### Sanity checklist before committing

- [ ] Command name is kebab-case and matches the `handleInteraction` branch string exactly.
- [ ] Required vs optional option flags are correct (`.setRequired(true/false)`).
- [ ] Any string option that becomes a path/shell argument runs through a validator.
- [ ] Fast validation replies are `MessageFlags.Ephemeral`; slow work is `deferReply()` + `editReply()`.
- [ ] Long output uses `sendLong()` (or at minimum respects the 2000-char cap).
- [ ] `npm run typecheck && npm run lint && npm run prettier` all pass.

## Gotchas

- **Guild vs global registration is controlled ONLY by `DISCORD_GUILD_ID`.** There's no per-command toggle. If you want one command global and another guild-only you need to restructure.
- **`rest.put` replaces everything.** Don't try to `POST` individual commands thinking it appends — that would create duplicates on subsequent runs until Discord dedupes.
- **`commandName` is matched as a plain string.** Rename carefully; the builder `.setName(...)` and the `handleInteraction` branch must move together.
- **Threads vs their parent channel.** `interaction.channel.parentId` is only non-null inside a thread. `resolveProjectContext()` handles this; reuse it instead of duplicating the check.
- **Argument access.** `interaction.options.getString("name", true)` — the second arg `true` tells discord.js the option is required (throws if missing). Without it, the return is `string | null`.
- **Don't trust string options.** They're user-provided. Always validate before passing to shell/paths (`execFile` helps because it doesn't spawn a shell, but a malicious name could still traverse directories).

## References

- discord.js docs for `SlashCommandBuilder`, `ChatInputCommandInteraction`, `REST`, `Routes`.
- Discord developer docs on application commands: registration, permissions, and the 3-second / 15-minute deadlines.
- `src/slash-commands.ts` — the current, canonical implementation.
- `src/bot.ts` — how the ready/interactionCreate events wire it up.
