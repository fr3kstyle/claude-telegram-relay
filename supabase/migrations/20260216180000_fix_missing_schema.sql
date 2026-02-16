-- ============================================================
-- Fix Missing Schema Elements - Apply via Supabase Dashboard SQL Editor
-- ============================================================
-- This migration adds missing elements that were defined but not applied:
-- 1. agent_loop_state table
-- 2. retry_count, status, metadata columns on global_memory
-- 3. Memory view with rules for backward compatibility

-- ============================================================
-- 1. ADD MISSING COLUMNS TO GLOBAL_MEMORY
-- ============================================================
ALTER TABLE global_memory DROP CONSTRAINT IF EXISTS global_memory_type_check;

-- Add columns if not exist (Postgres doesn't have IF NOT EXISTS for ALTER COLUMN)
DO $$
BEGIN
  -- parent_id
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'global_memory' AND column_name = 'parent_id') THEN
    ALTER TABLE global_memory ADD COLUMN parent_id UUID REFERENCES global_memory(id) ON DELETE CASCADE;
  END IF;

  -- status
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'global_memory' AND column_name = 'status') THEN
    ALTER TABLE global_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  END IF;

  -- weight
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'global_memory' AND column_name = 'weight') THEN
    ALTER TABLE global_memory ADD COLUMN weight FLOAT DEFAULT 1.0;
  END IF;

  -- retry_count
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'global_memory' AND column_name = 'retry_count') THEN
    ALTER TABLE global_memory ADD COLUMN retry_count INTEGER DEFAULT 0;
  END IF;

  -- last_error
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'global_memory' AND column_name = 'last_error') THEN
    ALTER TABLE global_memory ADD COLUMN last_error TEXT;
  END IF;

  -- metadata
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'global_memory' AND column_name = 'metadata') THEN
    ALTER TABLE global_memory ADD COLUMN metadata JSONB DEFAULT '{}';
  END IF;
END $$;

-- Add the expanded type constraint
ALTER TABLE global_memory ADD CONSTRAINT global_memory_type_check
  CHECK (type IN (
    'fact',
    'goal',
    'completed_goal',
    'preference',
    'reminder',
    'note',
    'action',
    'strategy',
    'reflection',
    'system_event'
  ));

-- Add status check constraint
ALTER TABLE global_memory DROP CONSTRAINT IF EXISTS global_memory_status_check;
ALTER TABLE global_memory ADD CONSTRAINT global_memory_status_check
  CHECK (status IN ('active', 'pending', 'blocked', 'completed', 'archived'));

-- ============================================================
-- 2. CREATE INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_global_memory_status ON global_memory(status);
CREATE INDEX IF NOT EXISTS idx_global_memory_parent ON global_memory(parent_id);
CREATE INDEX IF NOT EXISTS idx_global_memory_pending_actions
  ON global_memory(priority DESC NULLS LAST, created_at ASC)
  WHERE type = 'action' AND status IN ('active', 'pending');
CREATE INDEX IF NOT EXISTS idx_global_memory_blocked
  ON global_memory(created_at DESC)
  WHERE status = 'blocked';
CREATE INDEX IF NOT EXISTS idx_global_memory_active_goals_hierarchy
  ON global_memory(priority DESC NULLS LAST, created_at ASC)
  WHERE type = 'goal' AND status = 'active' AND parent_id IS NULL;

-- ============================================================
-- 3. CREATE OR REPLACE MEMORY VIEW
-- ============================================================
DROP VIEW IF EXISTS memory CASCADE;
CREATE VIEW memory AS SELECT * FROM global_memory;

-- Make the view updatable
CREATE OR REPLACE RULE memory_insert AS ON INSERT TO memory
  DO INSTEAD INSERT INTO global_memory
    (id, created_at, content, type, deadline, completed_at, priority, embedding, source_thread_id, parent_id, status, weight, retry_count, last_error, metadata)
  VALUES
    (NEW.id, NEW.created_at, NEW.content, NEW.type, NEW.deadline, NEW.completed_at, NEW.priority, NEW.embedding, NEW.source_thread_id, NEW.parent_id, NEW.status, NEW.weight, NEW.retry_count, NEW.last_error, NEW.metadata)
  RETURNING id;

CREATE OR REPLACE RULE memory_update AS ON UPDATE TO memory
  DO INSTEAD UPDATE global_memory SET
    created_at = NEW.created_at,
    content = NEW.content,
    type = NEW.type,
    deadline = NEW.deadline,
    completed_at = NEW.completed_at,
    priority = NEW.priority,
    embedding = NEW.embedding,
    source_thread_id = NEW.source_thread_id,
    parent_id = NEW.parent_id,
    status = NEW.status,
    weight = NEW.weight,
    retry_count = NEW.retry_count,
    last_error = NEW.last_error,
    metadata = NEW.metadata
  WHERE id = OLD.id;

CREATE OR REPLACE RULE memory_delete AS ON DELETE TO memory
  DO INSTEAD DELETE FROM global_memory WHERE id = OLD.id;

-- ============================================================
-- 4. CREATE AGENT_LOOP_STATE TABLE
-- ============================================================
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

-- Insert default state if not exists
INSERT INTO agent_loop_state (loop_type, status)
VALUES ('main', 'idle')
ON CONFLICT DO NOTHING;

ALTER TABLE agent_loop_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON agent_loop_state;
CREATE POLICY "service_role_all" ON agent_loop_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 5. LOG MIGRATION
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Fixed missing schema elements',
  '{"version": "20260216180000", "added": ["agent_loop_state", "memory_columns", "memory_view"]}'::jsonb
);
