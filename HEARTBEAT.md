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

## Current Status (Updated 2026-02-17 15:20)

### Active Goals
- [P0] Complete OAuth integration hardening (deadline 3/31)
- [P3] Outlook OAuth: Code complete - needs microsoft-credentials.json from Azure Portal (see docs/azure-credentials-setup.md)

### Pending Supabase Migrations
Run these in Supabase Dashboard SQL Editor (https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new):

**Completed:**
- [x] `20260216120000_fix_match_memory.sql` - Fix match_memory RPC (**DEPLOYED** 2026-02-17)
- [x] `20260216140000_goal_hygiene_rpc.sql` - Goal hygiene RPCs (**DEPLOYED** 2026-02-17)
- [x] `20260217020000_email_stats_rpc.sql` - Email stats RPCs (**DEPLOYED** 2026-02-17)

**Trading System Migrations** (apply in order - tables don't exist yet):
- [ ] `20260217170000_trading_market_data.sql` - OHLCV, features, market structure
- [ ] `20260217180000_trading_signals.sql` - Signal generation tables
- [ ] `20260217190000_trading_executions.sql` - Trade execution tables
- [ ] `20260217200000_trading_risk.sql` - Risk management tables
- [ ] `20260217210000_trading_ml.sql` - ML model tables
- [ ] `20260217220000_trading_system.sql` - System config tables
- [ ] `20260217133000_rls_audit_fix.sql` - RLS policies (depends on above)

### System Resources
- System has 3.8GB RAM, ~1.8GB available
- All PM2 services online (12 services, 681MB total)
- Trading scanners running: top10, top20, top50 (combined ~185MB)

### Trading Scanner Resource Analysis (Updated 2026-02-17 Cycle 78)
| Scanner | Memory | Status |
|---------|--------|--------|
| scanner-top10 | 64MB | Running |
| scanner-top20 | 63MB | Running |
| scanner-top50 | 58MB | Running |
| **Total PM2** | **681MB** | All 12 services online |

### Recent Completions (Cycle 78)
- [x] PM2 daemon mode for goal-engine, deep-think, pattern-miner (prevents restart loops)
- [x] Graceful degradation action completed (SupabaseResilience layer integrated)
- [x] Trading scanner resource review completed (scanners running within budget)
