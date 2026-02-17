# Heartbeat Checklist

Check these items on each heartbeat cycle. Report anything noteworthy.
If everything is normal, respond with HEARTBEAT_OK.

## fr3k's Context

- **Location:** Brisbane, Australia (GMT+10)
- **Work Pattern:**
  - High Focus: 8am-12pm (deep work, planning, architecture)
  - Execution: 1pm-6pm (coding, debugging, shipping)
  - Main Window: 8pm-11pm (coding, shipping, deep focus)
  - Low Cognitive: After 11pm (light tasks)

## What to Check

- System health: disk space, memory, running services
- Active goals: any deadlines approaching or stalled goals
- Pending tasks: uncommitted changes, unfinished work
- Calendar: upcoming events in next 24h (if calendar MCP available)
- Email: unread count or important emails (if email MCP available)

## When to Report

Report when:
- System issues (low disk, high memory, service down)
- Goal deadline within 24 hours
- Work pattern suggests transition (e.g., "switching to execution mode")
- Uncommitted code changes detected
- Calendar event in next 2 hours

Stay silent (HEARTBEAT_OK) when:
- Everything routine, no action needed
- Outside active hours (11pm-8am)
- No pending items requiring attention

## Current Status (Updated 2026-02-17 14:00)

### Active Goals
- [P0] Complete OAuth integration hardening (deadline 3/31)
- [P3] Outlook OAuth: Code complete - needs microsoft-credentials.json from Azure Portal (see docs/azure-credentials-setup.md)
- [P4] Apply email stats RPC migration via Supabase Dashboard (deadline 2/24)

### Pending Supabase Migrations
Run these in Supabase Dashboard SQL Editor (https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new):
- [ ] `20260216120000_fix_match_memory.sql` - Fix match_memory RPC to query correct table
- [ ] `20260216140000_goal_hygiene_rpc.sql` - Goal hygiene RPC functions
- [ ] `20260217020000_email_stats_rpc.sql` - Email stats aggregation RPCs

Note: `memory` and `global_memory` tables both exist. match_memory should query `memory` table.

### Memory Constraints
- System has 3.8GB RAM, ~1.9GB available
- Agent-loop stable (43m+ uptime)
- Deep-think and goal-engine stopped to conserve memory

### Recent Completions
- [x] RLS policies added to trading and self-improvement tables (2026-02-17)
- [x] Trading commands and PM2 scanner config (2026-02-17)
- [x] Azure credentials setup guide (docs/azure-credentials-setup.md)
- [x] microsoft-credentials.json schema documented (2026-02-17)
- [x] Goal hygiene check: 299 entries, 0 stale, 0 duplicates, 0 malformed (2026-02-17 cycle 69)
