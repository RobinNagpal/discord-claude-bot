import type { JobConfig, JobHandler } from "../types.js";

const handler: JobHandler = {
  buildPrompt(config: JobConfig): string {
    return `Produce a concise Claude Code usage report and write it to ${config.resultFile}. Keep the report under ~15 lines of plain text.

Include, if the data is available:
- Tokens used and approximate cost for the **last 30 minutes** (input / output / cache-read / cache-creation tokens separately).
- Tokens used and approximate cost for **today since 00:00 local time**.
- Per-model breakdown (Opus / Sonnet / Haiku) by output tokens.
- Number of active sessions in the last 30 minutes.

How to get the data (try in order, stop once one works):
1. If the \`ccusage\` CLI is installed (\`which ccusage\`), run it and parse its output.
2. Otherwise, walk the Claude Code session JSONL files under \`~/.claude/projects/*/*.jsonl\` and tally token usage from assistant-turn \`usage\` objects. Sum input_tokens, output_tokens, cache_creation_input_tokens, and cache_read_input_tokens separately, and filter by assistant-turn timestamp for the time windows above.
3. If neither data source is available or has no records, say so in one short line and suggest installing ccusage — do NOT invent numbers.

Output format: plain text, no headings or preambles, labeled lines like:
  Last 30 min: input=X, output=Y, cache_read=Z, cache_creation=W, ~$N
  Today:       input=X, output=Y, cache_read=Z, cache_creation=W, ~$N
  Models:      Opus=X%, Sonnet=Y%, Haiku=Z%
  Sessions:    N active in last 30 min

If a field is unknown, drop it rather than guessing. Do not add any commentary, explanations, or trailing summary — just the labeled lines. This is an automated report that gets posted to Discord verbatim.`;
  },
};

export default handler;
