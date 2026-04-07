# Outreach Data Agent

## Overview
Handles email outreach campaigns for DoDAO/KoalaGains. Collects contact data, composes personalized emails, sends them via Gmail, and manages followups — all via Claude Code CLI.

## Workspace & Paths
- **Workspace:** `/home/ubuntu/.openclaw/workspace-outreach-data`
- **Campaigns:** `/home/ubuntu/.openclaw/workspace-outreach-data/campaigns/`
- **Campaign assets (scripts):** `/home/ubuntu/.openclaw/workspace-outreach-data/campaign_assets/`
- **Cron tasks:** `/home/ubuntu/.openclaw/workspace-outreach-data/cron-tasks/`
- **Result file:** `/tmp/claude-code-result-outreach-data.md`

## Google Workspace Integration

**Account:** `ryan@koalagains.com`

**Required env vars for all `gog` commands:**
```
GOG_KEYRING_BACKEND=file
GOG_KEYRING_PASSWORD=lollY.789
```

### Google Sheets
- **Sheet ID:** `1Kmg1f0iJbWIv5oWFXQJmxFHVRTO9EKC67SuPDiTcOcc`
- Append (no commas): `gog sheets append <id> "<Tab>!A:Z" 'v1|v2|v3' --account ryan@koalagains.com`
- Append (with commas): `gog sheets append <id> "<Tab>!A:Z" --values-json '[["v1","v2"]]' --account ryan@koalagains.com`

### Gmail
- Send: `gog gmail send --to "email" --subject "subject" --body-html "<html>body</html>" --account ryan@koalagains.com --force --json`
- Reply in thread: `gog gmail send --thread-id "THREAD_ID" --to "email" --subject "Re: subject" --body-html "body" --account ryan@koalagains.com --force`
- Get thread: `gog gmail thread get THREAD_ID --json --account ryan@koalagains.com`
- Assign label: `gog gmail thread modify THREAD_ID --add "label-name" --account ryan@koalagains.com`
- Labels: `e-degree`, `followup 1`, `followup 2`, `amb-prgm`
- Always use `--force` (skip confirmation), `--json` (capture threadId), `--body-html` (not `--body`)

## Active Campaigns

### 1. E-Degree (Business E-Degree Programs)

**Objective:** Collect contact data for management/leadership at universities offering online business degrees (MBA, BBA).

**Campaign file:** `campaigns/e-degree.md`
**Sheet tab:** `University Programs` (8 cols) + `Contacts` (15 cols)

**Target contacts:** Dean of Business School, Program Director (Online/E-Degree), Associate Dean of Academic Programs, Department Chair/Head of Business, Director of Online Learning.

**Workflows:**
1. **Data collection** — Find universities with online business programs, collect contact info
2. **Write emails** — Fill Subject (col J) & Body (col K) for rows without them
3. **Send emails** — Send via Gmail, capture threadId in col M
4. **1st followup** — Reply in thread if initial email >4 days old
5. **2nd followup** — Final followup if 1st followup >4 days old

**Email guidelines:**
- Rotate subject lines (8 variants in campaign file)
- Greeting: Hi/Dear [Name], vary opening lines
- Core message: KoalaGains AI platform for hands-on portfolio building
- Include video link: `<a href="http://koalagains.com/video/koalagains-demo.mp4">Watch Video</a>`
- Sign-off: Warm regards, Ryan Smith, Outreach @ KoalaGains + LinkedIn
- HTML format: no `<p>` tags, use `<br>` for breaks, embed URLs in `<a>` tags only
- Single continuous string (no literal newlines)

### 2. Amb Prgm (Ambassador Program — Placement Offices)

**Objective:** Collect contact data for placement/career services offices at universities with business degrees.

**Campaign file:** `campaigns/amb-prgm/campaign-info.md` (+ `write-emails.md`, `send-emails.md`, `followup-1.md`, `followup-2.md`)
**Sheet tab:** `Amb Prgm` (15 cols)

**Target contacts:** Director/Head of Placement Cell, Training & Placement Officer (TPO), Head of Career Services, Dean of Placements.

**Target institutions:** Universities/colleges with BBA, MBA, B.Com, M.Com, PGDM, BMS.

**Email guidelines:**
- Detect person vs office: use person greeting (Hi [Name]) if real name in col H, else office greeting (Hello Placement Office Team)
- Core message: Global Student Ambassador Program (1 month), hands-on research & portfolio building
- Include: `<a href="https://drive.google.com/drive/folders/1iphPWM2sd7-gVlh92FVyhR1z1Cf7_qs8">Program Materials</a>`
- Sign-off: Warm regards, Ryan Smith, Outreach @ KoalaGains + LinkedIn
- Same HTML rules as e-degree (no `<p>`, use `<br>`, single string)

## Claude Code Spawn Template

All tasks are delegated to Claude Code. Spawn with:

```
claude -p --dangerously-skip-permissions '<TASK PROMPT>

Environment setup:
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD=lollY.789

Google account: ryan@koalagains.com
Sheet ID: 1Kmg1f0iJbWIv5oWFXQJmxFHVRTO9EKC67SuPDiTcOcc

Read the campaign file at: <CAMPAIGN_FILE_PATH>
Follow the instructions in the campaign file exactly.

When completely finished:
1. Write summary to /tmp/claude-code-result-outreach-data.md (records found, records added, errors)
2. Run: openclaw system event --text "Done: [brief summary]" --mode now'
```

Use `workdir: /home/ubuntu/.openclaw/workspace-outreach-data` when spawning.

## Task Types

### Data Collection / Lead Generation
- Read campaign file for target criteria (states, countries, degree types)
- Check for duplicates in existing sheet FIRST
- Search for universities, find placement/department contacts
- NEVER guess or invent emails — leave empty if not found
- Write to Google Sheet using `gog sheets append`

### Write Emails
- Read existing rows from sheet that have no Subject/Body
- Compose personalized email using campaign guidelines
- Update sheet with Subject + Body columns

### Send Emails
- Use `find-eligible-send.py` script to find first eligible row
- Send via `gog gmail send`, capture threadId
- Update sheet with threadId
- Assign Gmail label

### Followups (1st and 2nd)
- Use `find-eligible-followup1.py` or `find-eligible-followup2.py`
- Respects 4-day minimum wait between emails
- Reply in same thread using `--thread-id`
- Update sheet (followup 1/2 = "yes")

## Critical Rules
- **One email per cron invocation** — never loop or batch send (causes spam flagging)
- **Run find-eligible script exactly ONCE** per invocation
- **Never guess emails or phone numbers** — leave empty if not found
- **Use pipe `|` separator** for values without commas, `--values-json` for values with commas
- **Format email body as single-line HTML** — no literal newlines, use `<br>`
- **No `<p>` tags** — only `<br>` and `<a>` tags
- **Vary email wording** across sends — rotate subjects, vary greetings/openings/closings
- **Always use `--force`** flag with `gog gmail send`
- **Only use publicly available data** from official websites
- **Verify emails match institution domain**
