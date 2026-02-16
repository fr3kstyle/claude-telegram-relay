-- ============================================================
-- PARTIAL MIGRATION FIX: Add missing columns
-- ============================================================
-- Status as of 2026-02-16:
--   EXISTS: status, parent_id, weight
--   MISSING: retry_count, last_error, metadata
--
-- Run this in: https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql

-- PART 1: Add only the missing columns
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- PART 2: Update type constraint to include new types
ALTER TABLE global_memory DROP CONSTRAINT IF EXISTS global_memory_type_check;
ALTER TABLE global_memory ADD CONSTRAINT global_memory_type_check
  CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'reminder', 'note', 'action', 'strategy', 'reflection', 'system_event'));

-- PART 3: Create missing indexes for new columns
CREATE INDEX IF NOT EXISTS idx_global_memory_status ON global_memory(status);
CREATE INDEX IF NOT EXISTS idx_global_memory_parent ON global_memory(parent_id);
CREATE INDEX IF NOT EXISTS idx_global_memory_pending_actions
  ON global_memory(priority DESC, created_at ASC)
  WHERE type = 'action' AND status IN ('active', 'pending');
CREATE INDEX IF NOT EXISTS idx_global_memory_blocked
  ON global_memory(updated_at DESC)
  WHERE status = 'blocked';
CREATE INDEX IF NOT EXISTS idx_global_memory_active_goals_hierarchy
  ON global_memory(priority DESC, created_at ASC)
  WHERE type = 'goal' AND status = 'active' AND parent_id IS NULL;

-- PART 4: Create agent_loop_state table
CREATE TABLE IF NOT EXISTS agent_loop_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_type TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'paused', 'error')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_cycle_summary TEXT,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_loop_state_main
  ON agent_loop_state(loop_type) WHERE loop_type = 'main';

INSERT INTO agent_loop_state (loop_type, status)
VALUES ('main', 'idle')
ON CONFLICT (loop_type) WHERE loop_type = 'main' DO NOTHING;

ALTER TABLE agent_loop_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON agent_loop_state;
CREATE POLICY "service_role_all" ON agent_loop_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- PART 5: Update existing rows to have status='active'
UPDATE global_memory SET status = 'active' WHERE status IS NULL;

-- PART 6: Clean up invalid entries (content='fact', content='text', content='goal')
DELETE FROM global_memory WHERE content IN ('fact', 'text', 'goal');

-- PART 7: Log migration
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Partial migration fix applied - columns added',
  '{"version": "20260216150000_fix"}'::jsonb
);
