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

## Current Status (Updated 2026-02-17)

### Active Goals
- [P3] Outlook OAuth: Code complete - needs microsoft-credentials.json from Azure Portal (by 3/15/2026)

### Pending Supabase Migrations
Run these in Supabase Dashboard SQL Editor:
- [ ] `20260216140000_goal_hygiene_rpc.sql` - Goal hygiene RPC functions
- [ ] `20260217020000_email_stats_rpc.sql` - Email stats aggregation RPCs

### Memory Constraints
- System has 3.8GB RAM, ~2GB available
- Agent-loop stable with 34m+ uptime after OOM issues resolved
- Multiple Claude processes consume ~750MB total
- Deep-think and goal-engine stopped to conserve memory

### Recent Completions
- [x] RLS policies added to trading and self-improvement tables (2026-02-17)
- [x] Trading commands and PM2 scanner config (2026-02-17)
