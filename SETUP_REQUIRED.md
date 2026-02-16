# Manual Setup Required

## 1. Apply Supabase Migration (Required for autonomous operations)

The following migrations need to be applied via Supabase Dashboard SQL Editor:

**URL:** https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new

**Files to apply (in order):**
1. `supabase/migrations/manual_apply_now.sql` - Core schema updates (columns, tables, RPCs)

Or copy-paste the contents of that file directly into the SQL editor and run it.

This will add:
- `retry_count`, `last_error`, `metadata` columns to `global_memory`
- `agent_loop_state` table for tracking autonomous cycles
- `goal_hygiene()` RPC for analyzing goal health
- `get_pending_actions()` RPC for action queue

## 2. Google OAuth Setup (Required for email monitoring)

Email monitoring is fully coded but needs OAuth credentials:

**Steps:**
1. Go to: https://console.cloud.google.com/apis/credentials
2. Create OAuth client ID (Web application)
3. Add authorized redirect URI: `http://localhost:8080/callback`
4. Download the JSON credentials file
5. Save to: `~/.claude-relay/google-credentials.json`
6. Run: `bun run src/google-oauth.ts`
7. Follow the interactive prompts to authorize each email account

**Currently configured accounts:**
- Fr3kchy@gmail.com
- fr3k@mcpintelligence.com.au

## Status

- [ ] Migration applied
- [ ] OAuth credentials configured
- [ ] Tokens obtained for email accounts

Once both are complete, email monitoring will be operational.
