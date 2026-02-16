-- ============================================================
-- PARTIAL MIGRATION: Add missing autonomous agent components
-- ============================================================
-- Run in Supabase Dashboard SQL Editor
-- This adds only the missing pieces identified on 2026-02-16

-- ============================================================
-- 1. Add missing columns to global_memory
-- ============================================================

ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- ============================================================
-- 2. Create missing RPC functions
-- ============================================================

CREATE OR REPLACE FUNCTION mark_action_blocked(p_id UUID, p_error TEXT) RETURNS VOID AS $$
BEGIN UPDATE global_memory SET status = 'blocked', last_error = p_error, retry_count = retry_count + 1, metadata = jsonb_set(COALESCE(metadata, '{}'), '{blocked_at}', to_jsonb(NOW())) WHERE id = p_id; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mark_action_completed(p_id UUID) RETURNS VOID AS $$
BEGIN UPDATE global_memory SET status = 'completed', completed_at = NOW() WHERE id = p_id; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION complete_goal_cascade(goal_id UUID) RETURNS VOID AS $$
BEGIN UPDATE global_memory SET type = 'completed_goal', status = 'completed', completed_at = NOW() WHERE id = goal_id; UPDATE global_memory SET status = 'completed', completed_at = NOW() WHERE parent_id = goal_id; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION block_goal(goal_id UUID, reason TEXT) RETURNS VOID AS $$
BEGIN UPDATE global_memory SET status = 'blocked', metadata = jsonb_set(COALESCE(metadata, '{}'), '{blocked_reason}', to_jsonb(reason)) WHERE id = goal_id; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION decompose_goal(parent_goal_id UUID, item_type TEXT, item_content TEXT, item_priority INTEGER DEFAULT 3) RETURNS UUID AS $$
DECLARE new_id UUID; BEGIN INSERT INTO global_memory (type, content, priority, parent_id, status) VALUES (item_type, item_content, item_priority, parent_goal_id, 'active') RETURNING id INTO new_id; RETURN new_id; END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. Create memory view for backward compatibility
-- ============================================================

CREATE OR REPLACE VIEW memory AS SELECT * FROM global_memory;

CREATE OR REPLACE RULE memory_insert AS ON INSERT TO memory DO INSTEAD INSERT INTO global_memory VALUES (NEW.*);
CREATE OR REPLACE RULE memory_update AS ON UPDATE TO memory DO INSTEAD UPDATE global_memory SET created_at = NEW.created_at, content = NEW.content, type = NEW.type, deadline = NEW.deadline, completed_at = NEW.completed_at, priority = NEW.priority, embedding = NEW.embedding, source_thread_id = NEW.source_thread_id, parent_id = NEW.parent_id, status = NEW.status, weight = NEW.weight, retry_count = NEW.retry_count, last_error = NEW.last_error, metadata = NEW.metadata WHERE id = OLD.id;
CREATE OR REPLACE RULE memory_delete AS ON DELETE TO memory DO INSTEAD DELETE FROM global_memory WHERE id = OLD.id;

-- ============================================================
-- 4. Create agent_loop_state table
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_loop_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_type TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'paused', 'error')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_cycle_summary TEXT,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_loop_state_main ON agent_loop_state(loop_type) WHERE loop_type = 'main';
INSERT INTO agent_loop_state (loop_type, status) VALUES ('main', 'idle') ON CONFLICT (loop_type) WHERE loop_type = 'main' DO NOTHING;
ALTER TABLE agent_loop_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service_role_all" ON agent_loop_state FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 5. Log migration
-- ============================================================

INSERT INTO logs_v2 (event, message, metadata) VALUES ('schema_migration', 'Partial autonomous agent migration applied', '{"version": "20260216150000-partial", "added": ["retry_count", "last_error", "metadata", "agent_loop_state", "memory_view", "missing_rpcs"]}'::jsonb);
