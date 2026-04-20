# ETF Prompt Review - Skill 2: Create Generation Requests for ETFs

Create analysis generation requests for a specific report category on a set of ETFs. This skill prefers reading ETFs from the “run file” produced by Skill 1, and will write request results back into that same file.

## Arguments
The user provides either:

- `<runFilePath>` (recommended), or
- `<category> <ETF1> <ETF2> ...`, or
- just `<category>` (if ETFs were already picked by Skill 1 in this conversation)

If a file path is provided, the skill must read `category` + ETF list from that file and treat it as the source of truth.

Categories: `PerformanceAndReturns`, `CostEfficiencyAndTeam`, `RiskAnalysis`

User input: $ARGUMENTS

## Procedure

### Step 1: Determine the ETFs and category

Resolve inputs in this priority order:

1) **If a run file path is provided**, read it and extract:
- **category** (from the “Run inputs” section)
- **ETFs** from the `## ETFs` markdown table (`exchange`, `symbol`, `name` columns; ignore other columns)

2) Otherwise parse the user input to get:
- **category**: One of `PerformanceAndReturns`, `CostEfficiencyAndTeam`, `RiskAnalysis`
- **ETFs**: Either from the arguments (e.g. "CostEfficiencyAndTeam VOO SPY AGG TLT") or from the most recent `/project:etf-pick-and-fetch` run in this conversation

If ETFs are specified as symbols, look up their exchange from context or assume NYSEARCA as default.

### Step 2: Create generation requests

Call the generation-requests API to create requests for all ETFs:

```
POST https://koalagains.com/api/koala_gains/etfs-v1/generation-requests?token=<AUTOMATION_SECRET>
Content-Type: application/json
Body: [
  {
    "etf": {"symbol": "VOO", "exchange": "NYSEARCA"},
    "regeneratePerformanceAndReturns": false,
    "regenerateCostEfficiencyAndTeam": true,
    "regenerateRiskAnalysis": false
  },
  ...
]
```

Set the regenerate flag to `true` ONLY for the requested category. Set all others to `false`.

Send all ETFs in a single request (the API accepts an array).

### Step 3: Write results back to the run file (if available)

If you resolved ETFs from a run file, update that same file by appending (or replacing) a section:

```markdown
## Generation requests

- category: <Category>
- createdAt: <YYYY-MM-DDTHH:mm:ssZ>

### Results
- <EXCHANGE>:<SYMBOL> — success (requestId: <...>) | error: <...>
```

Do not change the ETF selection. Only record results.

### Step 4: Report results

Print a summary showing:
- Which ETFs had generation requests created
- Which category was requested
- Any errors

### Notes

- The generation requests will be processed by the cron job that runs every 3 minutes
- Check progress at: https://koalagains.com/admin-v1/etf-generation-requests
- Once completed, the analysis results can be viewed at: https://koalagains.com/etfs/<EXCHANGE>/<SYMBOL>
