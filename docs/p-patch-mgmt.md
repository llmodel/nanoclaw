---
name: Garden Club Volunteer Activity Tracker
description: Rigorous volunteer hour tracking via email → Google Sheets, with member validation, human entry review, and monthly email reports
status: tabled
last-updated: 2026-03-15
---

# Context

Garden club members email volunteer activity reports. The system needs a controlled, auditable workflow — not auto-acceptance — because year-end data drives deposit refunds and membership termination decisions. Requirements:

1. **Member validation** — only accept reports from addresses the user has explicitly approved
2. **Entry review** — every entry is staged as "pending" until the user approves it; only approved entries count toward totals and reports
3. **Google Sheets storage** — easy for the user to read, edit, and verify directly
4. **Monthly email report** — compiled from approved entries only, emailed to boss

---

## Google Sheet Structure

One spreadsheet with three sheets:

### Sheet: `Members`
| email | name | approved_date |
|-------|------|---------------|
| jane@example.com | Jane Smith | 2026-03-15 |

### Sheet: `Activity Log`
| id | email | name | date | activity | hours | status | logged_at | reviewed_at | notes |
|----|-------|------|------|----------|-------|--------|-----------|-------------|-------|
| 2026-03-10T14:30Z | jane@... | Jane Smith | 2026-03-10 | Weeding rose beds | 2.5 | pending | 2026-03-10T14:30Z | | |

`status` values: `pending` → `approved` or `rejected`

### Sheet: `Annual Summary` (auto-generated on demand)
| name | email | approved_hours | commitment | status |
| Jane Smith | jane@... | 3.5 | 5 | 1.5h remaining |

---

## Workflow

### 1. Email from unknown sender
- Agent checks Members sheet for sender's email
- Not found → notify user in main channel:
  > "New volunteer report from **Jane Smith** &lt;jane@example.com&gt; — not in the approved member list. Add them? Send: `add member jane@example.com`"
- Do NOT parse or store the report yet
- Once user sends `add member <email>`, agent adds to Members sheet and re-processes the held email if the content is still available

### 2. Email from approved member — complete report
- Parse: name (from body or From header), date, activity, hours
- Append to Activity Log as `pending`
- Reply to member:
  > "Thanks Jane — your 2.5 hours for 'weeding rose beds' on March 10 have been received and are pending review."
- Notify user in main channel:
  > "New entry pending review: **Jane Smith** — 2.5h, weeding rose beds, March 10. See Activity Log sheet."

### 3. Email from approved member — incomplete report
- Missing required field(s) → reply asking specifically for what's missing
- Do NOT store anything yet

### 4. User approves / rejects entries
- User sends: `approve pending` (approves all) or `approve [id]` or `reject [id] reason`
- Agent updates status + reviewed_at in Activity Log
- Agent replies to member with their updated totals:
  > "Your entry for March 10 has been approved. Your 2026 total: **3.5 approved hours**. Remaining toward your 5-hour commitment: **1.5 hours**."

### 5. Monthly report (1st of each month, 8am)
- Filter Activity Log: status = `approved`, date within last month
- Compile per-member: activities list, monthly hours, year-to-date hours, remaining to 5h annual commitment
- Include club-wide stats: total members who reported, total hours, members with zero approved hours this year
- Email to boss (address configured in CLAUDE.md)

---

## Implementation Steps

### Step 1 — Add Google Sheets MCP to container

**File**: `container/agent-runner/src/index.ts`

Add to `mcpServers`:
```typescript
sheets: {
  command: 'npx',
  args: ['-y', 'google-sheets-mcp'],
},
```

Add to `allowedTools`:
```typescript
'mcp__sheets__*',   // verify exact prefix after install
```

**File**: `container/agent-runner/package.json` (if npx caching is unreliable, pre-install)

### Step 2 — GCP and auth setup

1. In the same GCP project used for Gmail:
   - Enable **Google Sheets API** (APIs & Services → Library)
2. Re-authorize to add the Sheets scope — the exact method depends on how `google-sheets-mcp` handles auth (verify at implementation time; it may share `~/.gmail-mcp/` or need separate credentials)
3. Rebuild container: `cd container && ./build.sh`

### Step 3 — Create the Google Sheet

User creates a new Google Sheet manually (or agent creates it via MCP if supported). Share the **spreadsheet ID** from the URL. Add three sheets named: `Members`, `Activity Log`, `Annual Summary`.

### Step 4 — Update `groups/main/CLAUDE.md`

Add a `## Volunteer Activity Tracking` section containing:
- The spreadsheet ID
- Boss's email address
- The workflow rules (steps 1–5 above)
- Required fields: date, activity, hours
- Natural language hour parsing rules (e.g. "two hours" → 2, "half an hour" → 0.5)
- Annual commitment = 5 hours (calendar year Jan 1 – Dec 31)

### Step 5 — Create monthly scheduled task (via chat)

User triggers once in chat; agent creates cron task `0 8 1 * *`:
```
Read the Activity Log sheet (status=approved, last month's dates). Compile a monthly
volunteer report and email it to [BOSS_EMAIL] with subject
"Garden Club Volunteer Report — [Month YYYY]".
```

---

## Files to Modify

- `container/agent-runner/src/index.ts` — add Sheets MCP server + allowed tools
- `groups/main/CLAUDE.md` — add volunteer tracking instructions (spreadsheet ID, boss email, workflow)

## Information Needed Before Execution

- **Boss's email address**
- **Spreadsheet ID** (from the Google Sheet URL after creating it)

---

## Verification

1. Create the Google Sheet manually; confirm agent can read/write it via `mcp__sheets__*` tools
2. Send a test email from an unknown address → agent asks user to approve the member
3. After approving member, send a complete activity report → entry appears in Activity Log as `pending`; member gets receipt reply
4. Send incomplete report → agent replies asking for missing field only
5. Send `approve pending` in chat → entry status updates to `approved`; member gets totals reply
6. Ask agent to generate monthly report manually → confirm formatted email arrives at boss's address
7. Check scheduled task exists: `list_tasks` shows cron `0 8 1 * *`
