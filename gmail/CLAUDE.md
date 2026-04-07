# Gmail Agent (Ambassador Email Workflows)

## Overview
Coordinates Gmail workflows for the KoalaGains ambassador program. Manages follow-up processing, CSV export, and email sending — all delegated to Claude Code CLI.

## Workspace & Paths
- **Workspace:** `/home/ubuntu/.openclaw/workspace-gmail`
- **Workflows:** `/home/ubuntu/.openclaw/workspace-gmail/workflows/`
- **CSV queue:** `/home/ubuntu/.openclaw/workspace-gmail/followups-required/`
- **Cron tasks:** `/home/ubuntu/.openclaw/workspace-gmail/cron-tasks/`
- **Result file:** `/tmp/claude-code-result-gmail.md`
- **Discord channel:** `1478459642790281319`

## Gmail Accounts
- **Processing (read/label):** `zain@koalagains.com`
- **Sending:** `ryan@koalagains.com`

**Required env vars:**
```
GOG_KEYRING_BACKEND=file
GOG_KEYRING_PASSWORD=lollY.789
```

## Three Workflows

### 1. amb_prgm_follow_up — Process & Label Threads

**File:** `workflows/amb_prgm_follow_up.md`
**Account:** `zain@koalagains.com`

Processes latest X ambassador-program threads and labels them as `followup-required` or `followup-not-required`.

**Search query:** `label:amb_prgm label:amb.todo -label:asset_mgmt -label:finance_prof -label:invalid -label:simulations -label:amb.processed -label:followup-required -label:followup-not-required`

**Label operations:**
- Add: `amb.processed` + one of (`followup-required` OR `followup-not-required`)
- Remove: `amb.todo`

**Decision rules:**
- Auto `followup-not-required`: delivery failures, student onboarding, FYI messages
- Auto `followup-required`: "Message blocked", unanswered questions, outreach with follow-up language
- Default: `followup-not-required` unless explicit question

### 2. export_follow_up — Export to CSV

**File:** `workflows/export_follow_up.md`
**Account:** `zain@koalagains.com`

Exports N follow-up-required threads to CSV, swaps `amb.processed` → `amb.completed`.

**Categories:**
- `campus_ambassador`: label `amb_prgm`, CSV `followups-required/exported_ambassador_followups.csv`
- `asset_managers`: label `asset_mgmt`, CSV `followups-required/exported_asset_followups.csv`

**CSV headers:** `threadId,senderEmail,receiverEmail,emailSubject,emailBody1,emailBody2,date`

### 3. send_follow_up — Send Follow-up Emails

**File:** `workflows/send_follow_up.md`
**Account:** `ryan@koalagains.com` (sending only)

Sends follow-up emails from CSV rows. On success: removes row from CSV, applies `amb-prgm` label. On failure: keeps row.

**Processing order:** oldest first (FIFO)

## Claude Code Spawn Template

```
claude -p --dangerously-skip-permissions '<TASK INSTRUCTIONS>

Instructions:
- Read workflows/<workflow_name>.md for the complete workflow steps
- Follow ALL steps and rules in the workflow file exactly
- Set env: GOG_KEYRING_BACKEND=file GOG_KEYRING_PASSWORD=lollY.789

When completely finished:
1. Write summary to /tmp/claude-code-result-gmail.md
2. Run: openclaw system event --text "Done: [brief summary]" --mode now'
```

Use `workdir: /home/ubuntu/.openclaw/workspace-gmail` when spawning.

## Rules
- Every Gmail command MUST include `--account zain@koalagains.com` or `--account ryan@koalagains.com`
- Do NOT use time filters (newer_than, etc.)
- Label operations at THREAD level only
- Process EXACTLY N threads when possible
- CSV must append rows, never overwrite
- Do NOT remove CSV rows unless email send succeeded
- amb_prgm_follow_up/export: newest first; send_follow_up: oldest first
