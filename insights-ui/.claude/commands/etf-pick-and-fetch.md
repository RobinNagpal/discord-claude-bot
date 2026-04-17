# ETF Prompt Review - Skill 1: Pick Diverse ETFs and Fetch Morningstar Data

Pick 4 diverse ETFs from the specified asset class and fetch all Morningstar data for them. Also write a single “run file” that records which `category` and `assetClass` are being processed and the 4 picks, so follow-up skills can reuse the exact selection and update the same file.

## Arguments
The user provides: `<category> <assetClass>`

Categories: `PerformanceAndReturns`, `CostEfficiencyAndTeam`, `RiskAnalysis`

Asset classes (examples): "Equity", "Fixed Income", "Alternatives", "Commodity", "Asset Allocation", "Currency"

User input: $ARGUMENTS

## Procedure

### Step 0: Parse inputs

Parse the user input to get:
- **category**: One of `PerformanceAndReturns`, `CostEfficiencyAndTeam`, `RiskAnalysis`
- **assetClass**: One of the supported ETF listing asset classes (e.g. "Fixed Income")

### Step 1: Fetch a sample of 100 ETFs from the given asset class

Use the existing ETF listing API (this replaces the non-existent `skills/pick-random-etfs` endpoint).

Call:

```
GET https://koalagains.com/api/koala_gains/etfs-v1/listing?page=1&pageSize=100&assetClass=<ASSET_CLASS>&token=<AUTOMATION_SECRET>
```

Notes:
- The response contains `etfs[]` items with: `symbol`, `name`, `exchange`, `aum` (string), and `inception` (string).
- If fewer than 100 are returned, proceed with what you got.

### Step 2: Pick 4 ETFs that are maximally different

From the returned `etfs[]`, select 4 picks with these roles:

1. **High AUM**: the ETF with the highest AUM (parse `aum` strings like `$190.08M`, `$12.3B`, etc.).
2. **Low AUM**: the ETF with the lowest non-null AUM (same parsing).
3. **New fund**: the ETF with the most recent `inception` date (parse `inception` if possible; if missing/invalid for all, pick a different random ETF).
4. **Random**: a random ETF from the remaining list not already selected.

Rules:
- All 4 picks must be distinct (no duplicate symbol+exchange).
- If a role cannot be satisfied (e.g., no AUM values), fall back to picking a random ETF not already selected and record the fallback reason.

For each picked ETF, produce a one-line pick reason (e.g. "High AUM: largest AUM in sample", "New fund: newest inception date in sample").

Print the picked ETFs with:
- symbol, name, exchange
- inception (if present)
- aum (if present)
- pickReason (one-liner)

### Step 3: Write the 4 picks to a knowledge file

Create (or overwrite) a markdown “run file” at:

`docs/ai-knowledge/insights-ui/etf-prompt-improvement/<category>/<assetClass>-<date>.md`

Where:
- `<category>` is the category argument value (as-is)
- `<assetClass>` is the asset class argument value lowercased with spaces replaced by `-` (e.g. `fixed-income`, `asset-allocation`)
- `<date>` is today’s date in `YYYY-MM-DD`

The file must include:
- Title line: `# ETF Prompt Improvement Run: <CATEGORY> / <ASSET_CLASS> (<YYYY-MM-DD>)`
- A “Run inputs” section with:
  - `category`: `<CATEGORY>`
  - `assetClass`: `<ASSET_CLASS>`
  - the listing API call used
  - count of ETFs in the sample (up to 100)
- The 4 picked ETFs as a table (this is what later skills will read/update):

```markdown
## ETFs

| exchange | symbol | name | inception | aum | pickReason |
|---|---|---|---|---|---|
| NYSEARCA | VOO | Vanguard S&P 500 ETF | 2010-09-07 | $... | High AUM: ... |
```

You may add additional columns later (e.g. generation request IDs, invocation IDs, review notes), but the columns above must exist.

### Step 4: Fetch all 4 types of Morningstar data for each picked ETF

For each of the 4 picked ETFs, call the fetch-mor-info API 4 times (once per kind):

```
POST https://koalagains.com/api/koala_gains/etfs-v1/exchange/<EXCHANGE>/<SYMBOL>/fetch-mor-info?token=<AUTOMATION_SECRET>
Content-Type: application/json
Body: {"kind": "quote"}
```

Call it for each kind: `quote`, `risk`, `people`, `portfolio`.

That means 4 ETFs × 4 kinds = 16 API calls total.

**Important**: Do NOT call the `fetch-financial-info` API — financial data is already present for all ETFs.

### Step 5: Report results

Print a summary showing:
- Each picked ETF (symbol, name, asset class, AUM)
- Whether all 4 Morningstar data fetch requests were submitted successfully
- Any errors encountered (per ETF, per kind)

The data will arrive via callbacks. No need to wait or verify — the callbacks will populate the data.

## Output

Return a clear list of the 4 ETFs picked (exchange + symbol), and confirm the **run file path** you wrote to. This path is the canonical input for Skill 2 and Skill 3.

