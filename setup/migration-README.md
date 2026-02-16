# Migration Required: Autonomous Agent Schema

## Status
The migration to support the autonomous agent system is partially complete. The following components are already in place:
- ✅ Columns: `status`, `parent_id`, `weight` on `global_memory`
- ✅ RPCs: `get_active_goals_with_children`, `get_pending_actions`, `get_strategies`, `get_reflections`, `get_agent_state`, `log_system_event`

## Required: Manual Migration
Please apply the remaining migration via Supabase Dashboard SQL Editor:

1. Open: https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql
2. Copy the contents of `setup/migration-partial.sql`
3. Paste and execute

## What This Adds
- Columns: `metadata`, `retry_count`, `last_error` on `global_memory`
- RPCs: `mark_action_blocked`, `mark_action_completed`, `complete_goal_cascade`, `block_goal`, `decompose_goal`
- View: `memory` (alias for `global_memory`)
- Table: `agent_loop_state`

## After Applying
Run verification:
```bash
bun run setup/verify-migration.ts
```
