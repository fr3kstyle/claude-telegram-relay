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

## Current Status (Updated 2026-02-17 18:46 - Cycle 106)

### Active Goals
- [P0] Complete OAuth integration hardening (deadline 3/31)
- [P3] Outlook OAuth: Code complete - needs microsoft-credentials.json from Azure Portal (see docs/azure-credentials-setup.md)

### Pending Supabase Migrations
Run these in Supabase Dashboard SQL Editor (https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new):

**Completed:**
- [x] `20260216120000_fix_match_memory.sql` - Fix match_memory RPC (**DEPLOYED** 2026-02-16)

**Ready to Apply (Manual):**
- [ ] `20260216140000_goal_hygiene_rpc.sql` - Goal hygiene RPCs (**NOT DEPLOYED** - was incorrectly marked as done)
  - Creates: goal_hygiene, archive_stale_items, delete_malformed_entries, merge_duplicate_goals
- [ ] `20260217020000_email_stats_rpc.sql` - Email stats RPCs (dependencies confirmed: email_accounts=3, email_messages=87)
  - **Apply via:** https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new
  - Paste contents of `supabase/migrations/20260217020000_email_stats_rpc.sql` and click Run
  - Creates: get_email_stats, get_email_volume_by_period, get_top_senders, get_email_account_health, get_recent_email_summary, get_label_distribution

**Trading System Migrations** (apply in order - tables don't exist yet):
- [ ] `20260217170000_trading_market_data.sql` - OHLCV, features, market structure
- [ ] `20260217180000_trading_signals.sql` - Signal generation tables
- [ ] `20260217190000_trading_executions.sql` - Trade execution tables
- [ ] `20260217200000_trading_risk.sql` - Risk management tables
- [ ] `20260217210000_trading_ml.sql` - ML model tables
- [ ] `20260217220000_trading_system.sql` - System config tables
- [ ] `20260217133000_rls_audit_fix.sql` - RLS policies (depends on above)

### System Resources
- System has 3.8GB RAM, ~2.0GB available (healthy)
- All PM2 services online (12 services, ~632MB total)
- Trading scanners running: top10, top20, top50 (combined ~181MB)

### Trading Scanner Resource Analysis (Updated 2026-02-17 Cycle 78)
| Scanner | Memory | Status |
|---------|--------|--------|
| scanner-top10 | 64MB | Running |
| scanner-top20 | 63MB | Running |
| scanner-top50 | 58MB | Running |
| **Total PM2** | **681MB** | All 12 services online |

### Recent Completions
- [x] **Cycle 106 (this):** System health check - all 12 PM2 services online, 2.0GB RAM available, 38% disk usage. Git is clean. Scanners running normally (0 signals - all below 75% threshold). Goal-engine idling (0 goals to decompose). Deep-think idling (1 goal < 2 threshold). No actionable items - Outlook OAuth blocked on Azure credentials, migrations require manual dashboard access. System stable.
- [x] **Cycle 104:** System health check - all 12 PM2 services online, 2.0GB RAM available, 38% disk usage. Git is clean. Scanners running normally (0 signals - all below 75% threshold). Goal-engine idling (0 goals to decompose). deep-think idling (1 goal < 2 threshold). Confirmed goal_hygiene RPC still not deployed (requires manual dashboard access). 409 conflict error from earlier PM2 restart was transient - relay now running normally. No actionable items - Outlook OAuth blocked on Azure credentials, migrations require manual dashboard access.
- [x] **Cycle 102:** System health check - all 12 PM2 services online, 1.8GB RAM available, 38% disk usage. Git is clean and up to date with origin. Scanners running normally (0 signals - all below 75% threshold). Goal-engine idling (0 goals to decompose). No actionable items - Outlook OAuth blocked on Azure credentials, migrations require manual dashboard access.
- [x] **Cycle 102 (earlier):** System health check - all 12 PM2 services online, 792MB RAM available, 38% disk usage. Memory table has 304 entries (126 reflections, 101 strategies, 44 facts, 14 goals). Git is clean and up to date with origin. goal_hygiene RPC confirmed NOT deployed (schema cache error). All migrations still pending manual dashboard access.
- [x] **Cycle 102 (earlier):** System health check - all 12 PM2 services online, 1.6GB RAM available, 38% disk usage. Setup verification passed (10 passed, 1 warning for GEMINI_API_KEY - expected since we use GROQ). Scanners running (0 signals - all below 75% threshold). No actionable items - Outlook OAuth blocked on Azure credentials, migrations require manual dashboard access. One unpushed commit: f92b2d7 (goal-engine global_memory fix).
- [x] **Cycle 102 (earlier):** System health check - all 12 PM2 services online, 1.9GB RAM available, 38% disk usage. Memory table has 303 entries (101 strategies, 125 reflections, 44 facts, 14 goals). Relay lock file verified correct (PID 55408).
- [x] **Cycle 99:** System health check - all 12 PM2 services online, 1.9GB RAM available, 38% disk usage. Transient API error (exit code 1) occurred but self-healing retry succeeded. Scanners running (0 signals - all below 75% threshold). deep-think/goal-engine idling (1 goal < 2 threshold).
- [x] **Cycle 97:** System health check - all 12 PM2 services online, 1.5GB RAM available, 38% disk usage. No actionable items - Outlook OAuth blocked on Azure credentials, migrations require manual dashboard access.
- [x] **Cycle 96:** System health check - all 12 PM2 services online, 475MB RAM available, 38% disk usage. Scanners running (0 signals - all below 75% threshold). deep-think/goal-engine idling (1 goal < 2 threshold).
- [x] **Cycle 95:** System health check - all 12 PM2 services online, 1.9GB RAM available, 38% disk usage
- [x] **Cycle 93:** Fixed PROJECT_DIR in .env (was `/home/radxa/`, now `/home/radxa/claude-telegram-relay`) - heartbeat was failing to find HEARTBEAT.md
- [x] Security: Added trading-status.ts to .gitignore (contained embedded credentials - never committed)
- [x] Security (Cycle 88): Found and deleted add-pairs.ts with embedded Bybit credentials - expanded .gitignore patterns
- [x] Scanner config update (Cycle 88): Committed base-scanner.ts changes with volatile pairs and 75% thresholds
- [x] Scanner symbol lists (Cycle 88): Committed top10/top20/top50 scanner symbol updates
- [x] PM2 daemon mode for goal-engine, deep-think, pattern-miner (prevents restart loops)
- [x] Graceful degradation action completed (SupabaseResilience layer integrated)
- [x] Trading scanner resource review completed (scanners running within budget)
- [x] OAuth scopes and consent flow documentation completed (Cycle 79)
- [x] OpenAI Whisper fallback for transcription (Cycle 80) - automatic failover when Groq fails
- [x] OAuth provider RSS feed monitoring script (Cycle 81) - `scripts/check-oauth-feeds.ts`
- [x] OAuth feed cron job integration (Cycle 85) - declarative cron in HEARTBEAT.md

### Weekly Reminders
- [x] **Monday (Feb 17):** Reviewed Telegram Bot API updates
  - **Bot API 9.4** released Feb 9, 2026: custom emoji for Premium bots, private chat topics, button styling (`style`, `icon_custom_emoji_id`), profile photo management (`setMyProfilePhoto`/`removeMyProfilePhoto`), chat owner events
  - Grammy 1.37.1 is current

## Cron Jobs
- "0 9 * * 1" Run bun run /home/radxa/claude-telegram-relay/scripts/check-oauth-feeds.ts and report any OAuth provider updates (Google Workspace, Microsoft 365, Microsoft Identity blogs)

### Enhancement Backlog
- [x] OAuth provider changelog monitoring (scripts/check-oauth-feeds.ts created Cycle 81)
