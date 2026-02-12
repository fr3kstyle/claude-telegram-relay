# PLAN.md — Phase 6: Schema & Infrastructure

**Goal:** Database tables and logging infrastructure ready for heartbeat and cron.

**Requirements:** INFRA-01, INFRA-02, INFRA-03, INFRA-04
**Depends on:** None (foundation phase)

**Key insight:** This phase is purely additive — no existing behavior changes. We create two new Supabase tables (`cron_jobs`, `heartbeat_config`), add CRUD helpers to `relay.ts`, wire a heartbeat timer into the relay lifecycle, and log events via the existing `logEventV2()`. The heartbeat timer is a skeleton: it ticks, reads config, and logs, but doesn't call Claude or send messages (that's Phase 7).

---

## Prompt 1: Supabase migration for cron_jobs and heartbeat_config tables

**File:** `supabase/migrations/20260212_heartbeat_cron_schema.sql`
**What:** Create two new tables: `cron_jobs` for scheduled jobs and `heartbeat_config` for heartbeat settings. Add RLS policies (service_role only, matching existing pattern). Add helper functions.

### Changes:

Create the migration file with:

```sql
-- ============================================================
-- Schema v2.1: Heartbeat & Cron Infrastructure
-- ============================================================
-- Adds tables for heartbeat configuration and cron job storage.
-- Part of Milestone v1.1: Heartbeat & Proactive Agent.

-- ============================================================
-- CRON JOBS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,                    -- Cron expression ("0 7 * * *") or interval ("every 2h") or one-shot ("in 20m")
  schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK (schedule_type IN ('cron', 'interval', 'once')),
  prompt TEXT NOT NULL,                      -- What to tell Claude
  target_thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  enabled BOOLEAN DEFAULT true,
  source TEXT DEFAULT 'user' CHECK (source IN ('user', 'agent')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at) WHERE enabled = true;

-- ============================================================
-- HEARTBEAT CONFIG TABLE (single-row config)
-- ============================================================
CREATE TABLE IF NOT EXISTS heartbeat_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  active_hours_start TEXT NOT NULL DEFAULT '08:00',
  active_hours_end TEXT NOT NULL DEFAULT '22:00',
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  enabled BOOLEAN DEFAULT true
);

-- Insert default config row
INSERT INTO heartbeat_config (interval_minutes, active_hours_start, active_hours_end, timezone, enabled)
VALUES (60, '08:00', '22:00', 'America/Sao_Paulo', true);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE cron_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON cron_jobs FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON heartbeat_config FOR ALL
  TO service_role USING (true) WITH CHECK (true);
```

### Verification:
- Migration file exists in `supabase/migrations/`
- `cron_jobs` table has columns: id, name, schedule, schedule_type, prompt, target_thread_id, enabled, source, created_at, updated_at, last_run_at, next_run_at
- `heartbeat_config` table has columns: id, interval_minutes, active_hours_start, active_hours_end, timezone, enabled, created_at, updated_at
- Default heartbeat config row inserted (60 min, 08:00-22:00, America/Sao_Paulo, enabled)
- RLS enabled with service_role policies (matching existing tables pattern)
- Indexes on `cron_jobs` for enabled jobs and next_run_at

---

## Prompt 2: Update reference schema file

**File:** `examples/supabase-schema-v2.sql`
**What:** Append the new `cron_jobs` and `heartbeat_config` table definitions to the reference schema file so it stays in sync with the actual migrations.

### Changes:

Append to the end of the file (before any final comments), after the existing helper functions section:

```sql
-- ============================================================
-- CRON JOBS TABLE (v1.1: Heartbeat & Proactive Agent)
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK (schedule_type IN ('cron', 'interval', 'once')),
  prompt TEXT NOT NULL,
  target_thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  enabled BOOLEAN DEFAULT true,
  source TEXT DEFAULT 'user' CHECK (source IN ('user', 'agent')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at) WHERE enabled = true;

-- ============================================================
-- HEARTBEAT CONFIG TABLE (v1.1: Heartbeat & Proactive Agent)
-- ============================================================
CREATE TABLE IF NOT EXISTS heartbeat_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  active_hours_start TEXT NOT NULL DEFAULT '08:00',
  active_hours_end TEXT NOT NULL DEFAULT '22:00',
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  enabled BOOLEAN DEFAULT true
);

INSERT INTO heartbeat_config (interval_minutes, active_hours_start, active_hours_end, timezone, enabled)
VALUES (60, '08:00', '22:00', 'America/Sao_Paulo', true);

ALTER TABLE cron_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON cron_jobs FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON heartbeat_config FOR ALL
  TO service_role USING (true) WITH CHECK (true);
```

### Verification:
- `examples/supabase-schema-v2.sql` includes both new tables
- Table definitions match the migration file exactly
- File remains valid SQL (no syntax errors from appending)

---

## Prompt 3: Add Supabase helper functions for heartbeat and cron

**File:** `src/relay.ts`
**What:** Add TypeScript interfaces and CRUD functions for the new tables. Place them after the existing Supabase v2 helpers (after `logEventV2()`, around line 455). These functions are called by the heartbeat timer (Prompt 4) and by future phases.

### Changes:

Add after the `logEventV2()` function:

```typescript
// ============================================================
// SUPABASE v2.1: Heartbeat & Cron helpers
// ============================================================

interface HeartbeatConfig {
  id: string;
  interval_minutes: number;
  active_hours_start: string;
  active_hours_end: string;
  timezone: string;
  enabled: boolean;
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  schedule_type: 'cron' | 'interval' | 'once';
  prompt: string;
  target_thread_id: string | null;
  enabled: boolean;
  source: 'user' | 'agent';
  last_run_at: string | null;
  next_run_at: string | null;
}

async function getHeartbeatConfig(): Promise<HeartbeatConfig | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("heartbeat_config")
      .select("*")
      .limit(1)
      .single();
    return data as HeartbeatConfig | null;
  } catch (e) {
    console.error("getHeartbeatConfig error:", e);
    return null;
  }
}

async function getEnabledCronJobs(): Promise<CronJob[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("cron_jobs")
      .select("*")
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    return (data || []) as CronJob[];
  } catch (e) {
    console.error("getEnabledCronJobs error:", e);
    return [];
  }
}

async function updateCronJobLastRun(jobId: string, nextRunAt?: string): Promise<void> {
  if (!supabase) return;
  try {
    const update: Record<string, unknown> = {
      last_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (nextRunAt) update.next_run_at = nextRunAt;
    await supabase.from("cron_jobs").update(update).eq("id", jobId);
  } catch (e) {
    console.error("updateCronJobLastRun error:", e);
  }
}

async function disableCronJob(jobId: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("cron_jobs")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    console.error("disableCronJob error:", e);
  }
}
```

### Verification:
- `HeartbeatConfig` and `CronJob` interfaces defined with correct fields matching migration
- `getHeartbeatConfig()` returns single-row config or null
- `getEnabledCronJobs()` returns only enabled jobs, ordered by creation
- `updateCronJobLastRun()` updates last_run_at and optionally next_run_at
- `disableCronJob()` sets enabled=false (for one-shot jobs after execution)
- All functions guard on `if (!supabase)` following existing pattern
- All functions have try/catch with console.error following existing pattern
- No new imports needed (uses existing `supabase` client)

---

## Prompt 4: Heartbeat timer lifecycle integration

**File:** `src/relay.ts`
**What:** Add a heartbeat timer that starts when the relay boots and stops on clean shutdown (SIGINT/SIGTERM). The timer reads heartbeat config from Supabase on each tick and logs the event. No Claude calls yet — that's Phase 7.

### Changes:

1. **Add heartbeat timer variable** after the `skillRegistry` variable (around line 179):

   ```typescript
   // Heartbeat timer — started after bot.start(), cleared on shutdown
   let heartbeatTimer: Timer | null = null;
   ```

2. **Add heartbeat tick function** after the new Supabase helpers (after Prompt 3's additions):

   ```typescript
   // ============================================================
   // HEARTBEAT TIMER (Infrastructure — Phase 6)
   // ============================================================

   async function heartbeatTick(): Promise<void> {
     try {
       const config = await getHeartbeatConfig();
       if (!config || !config.enabled) {
         console.log("Heartbeat: disabled or no config");
         return;
       }

       console.log("Heartbeat: tick");
       await logEventV2("heartbeat_tick", "Heartbeat timer fired", {
         interval_minutes: config.interval_minutes,
         enabled: config.enabled,
       });

       // Phase 7 will add: read HEARTBEAT.md, call Claude, handle HEARTBEAT_OK, send to Telegram
     } catch (e) {
       console.error("Heartbeat tick error:", e);
       await logEventV2("heartbeat_error", String(e).substring(0, 200));
     }
   }

   function startHeartbeat(intervalMinutes: number): void {
     if (heartbeatTimer) {
       clearInterval(heartbeatTimer);
     }
     const intervalMs = intervalMinutes * 60 * 1000;
     heartbeatTimer = setInterval(heartbeatTick, intervalMs);
     console.log(`Heartbeat: started (every ${intervalMinutes} min)`);
   }

   function stopHeartbeat(): void {
     if (heartbeatTimer) {
       clearInterval(heartbeatTimer);
       heartbeatTimer = null;
       console.log("Heartbeat: stopped");
     }
   }
   ```

3. **Update SIGINT handler** — add `stopHeartbeat()` call before `releaseLock()`:

   Find:
   ```typescript
   process.on("SIGINT", async () => {
     await releaseLock();
     process.exit(0);
   });
   ```

   Replace with:
   ```typescript
   process.on("SIGINT", async () => {
     stopHeartbeat();
     await logEventV2("bot_stopping", "Relay shutting down (SIGINT)");
     await releaseLock();
     process.exit(0);
   });
   ```

4. **Update SIGTERM handler** — same change:

   Find:
   ```typescript
   process.on("SIGTERM", async () => {
     await releaseLock();
     process.exit(0);
   });
   ```

   Replace with:
   ```typescript
   process.on("SIGTERM", async () => {
     stopHeartbeat();
     await logEventV2("bot_stopping", "Relay shutting down (SIGTERM)");
     await releaseLock();
     process.exit(0);
   });
   ```

5. **Start heartbeat after bot boots** — update the startup section at the bottom of the file:

   Find:
   ```typescript
   bot.start({
     onStart: () => {
       console.log("Bot is running!");
     },
   });
   ```

   Replace with:
   ```typescript
   bot.start({
     onStart: async () => {
       console.log("Bot is running!");

       // Start heartbeat timer from Supabase config
       const hbConfig = await getHeartbeatConfig();
       if (hbConfig?.enabled) {
         startHeartbeat(hbConfig.interval_minutes);
       } else {
         console.log("Heartbeat: disabled (no config or not enabled)");
       }
     },
   });
   ```

6. **Add heartbeat status to boot log** — update the console.log block near the bottom:

   Find:
   ```typescript
   console.log("Thread support: enabled (Grammy auto-thread)");
   ```

   After this line, add:
   ```typescript
   console.log(`Heartbeat: ${supabase ? "will start after boot" : "disabled (no Supabase)"}`);
   ```

### Verification:
- `heartbeatTimer` variable exists at module scope
- `heartbeatTick()` reads config from Supabase, logs "heartbeat_tick" event to logs_v2
- `startHeartbeat()` sets interval, `stopHeartbeat()` clears it
- SIGINT handler calls `stopHeartbeat()` before `releaseLock()`
- SIGTERM handler calls `stopHeartbeat()` before `releaseLock()`
- `bot.start()` onStart reads heartbeat config and starts timer if enabled
- Boot log includes heartbeat status line
- If Supabase is not configured, heartbeat gracefully does nothing
- Timer uses configurable interval from `heartbeat_config.interval_minutes`

---

## Prompt 5: Update CLAUDE.md with new schema and infrastructure

**File:** `CLAUDE.md`
**What:** Document the new `cron_jobs` and `heartbeat_config` tables in the Supabase Schema section. Add heartbeat timer to the Architecture section. Update dependencies to mention croner (upcoming).

### Changes:

1. **Update the Supabase Schema section** — find the tables list and add new tables:

   Find:
   ```
   Tables used by the relay:
   - `threads` — Conversation channels (telegram IDs, claude session, summary, message count)
   - `thread_messages` — Per-thread message history (role, content)
   - `global_memory` — Cross-thread learned facts (content, source thread)
   - `bot_soul` — Personality definitions (content, is_active)
   - `logs_v2` — Observability events (event, message, metadata, thread_id)
   ```

   Replace with:
   ```
   Tables used by the relay:
   - `threads` — Conversation channels (telegram IDs, claude session, summary, message count)
   - `thread_messages` — Per-thread message history (role, content)
   - `global_memory` — Cross-thread learned facts (content, source thread)
   - `bot_soul` — Personality definitions (content, is_active)
   - `logs_v2` — Observability events (event, message, metadata, thread_id)
   - `cron_jobs` — Scheduled jobs (name, schedule, prompt, target thread, source)
   - `heartbeat_config` — Single-row heartbeat settings (interval, active hours, timezone, enabled)
   ```

2. **Add migration reference** — find the Migration line and add:

   Find:
   ```
   Migration: `supabase/migrations/20260210202924_schema_v2_threads_memory_soul.sql`
   ```

   Replace with:
   ```
   Migrations:
   - `supabase/migrations/20260210202924_schema_v2_threads_memory_soul.sql` (v2: threads, memory, soul)
   - `supabase/migrations/20260212_heartbeat_cron_schema.sql` (v2.1: heartbeat config, cron jobs)
   ```

3. **Add heartbeat to Key sections** — find the Key sections list in Architecture and add after the Thread summary generation bullet:

   After the line about `maybeUpdateThreadSummary()`, add:
   ```
   - **Heartbeat timer** — `heartbeatTick()` fires at configurable interval (default 60min), reads config from Supabase, logs events. Starts on boot via `onStart`, stops on SIGINT/SIGTERM.
   ```

4. **Add heartbeat log event types** — after the Intent system bullet, add a note:

   After the `[VOICE_REPLY]` line, before `- **Thread routing middleware**`, add:
   ```
   - **Heartbeat & cron events** — Logged to `logs_v2` with event types: `heartbeat_tick`, `heartbeat_error`, `cron_executed`, `cron_error`, `bot_stopping`
   ```

### Verification:
- CLAUDE.md lists `cron_jobs` and `heartbeat_config` tables
- Migration list includes both migration files
- Heartbeat timer documented in Architecture section
- Event types documented for logging

---

## Execution Order

1. **Prompt 1** → Supabase migration SQL (standalone, no code dependencies)
2. **Prompt 2** → Update reference schema (standalone, parallelize with Prompt 1)
3. **Prompt 3** → Supabase helpers in relay.ts (standalone, parallelize with Prompts 1-2)
4. **Prompt 4** → Heartbeat timer lifecycle (depends on Prompt 3 — uses `getHeartbeatConfig()`)
5. **Prompt 5** → Update CLAUDE.md (documentation — can parallelize with Prompt 4)

Parallelizable groups:
- **Wave 1**: Prompts 1, 2, 3 (independent: migration SQL, reference SQL, TypeScript helpers)
- **Wave 2**: Prompts 4, 5 (timer depends on Prompt 3; docs independent)

## Files Modified

| File | Changes |
|------|---------|
| `supabase/migrations/20260212_heartbeat_cron_schema.sql` | New file: cron_jobs + heartbeat_config tables, RLS policies |
| `examples/supabase-schema-v2.sql` | Append cron_jobs + heartbeat_config definitions |
| `src/relay.ts` | HeartbeatConfig/CronJob interfaces, CRUD helpers, heartbeat timer lifecycle, shutdown hooks |
| `CLAUDE.md` | New tables documented, heartbeat timer described, event types listed |

## Roadmap Requirement Coverage

| Requirement | Prompt | How |
|-------------|--------|-----|
| INFRA-01: cron_jobs table with migration | Prompt 1 | Migration creates table with all required columns |
| INFRA-02: heartbeat_config in Supabase | Prompt 1 | Migration creates table with default row |
| INFRA-03: Heartbeat/cron events in logs_v2 | Prompt 4 | `heartbeatTick()` logs events via `logEventV2()` |
| INFRA-04: Timer integrates with relay lifecycle | Prompt 4 | Starts on boot, stops on SIGINT/SIGTERM |

## Risk Assessment

- **No risk**: Migration is a new file, doesn't touch existing tables
- **No risk**: Reference schema update is append-only
- **Low risk**: New functions in relay.ts are additive, no existing code modified
- **Low risk**: Heartbeat timer is a no-op skeleton (logs only), doesn't affect message handling
- **Low risk**: Shutdown handler changes add calls before existing `releaseLock()` — no behavior change on normal shutdown
- **Rollback**: Delete migration file, revert relay.ts additions, revert CLAUDE.md from git
