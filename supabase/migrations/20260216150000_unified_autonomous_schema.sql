-- ============================================================
-- Schema v2.4: Unified Autonomous Agent System
-- ============================================================
-- This migration extends the existing global_memory table to support
-- autonomous agent capabilities while maintaining backward compatibility.
--
-- Features added:
-- - Hierarchical goals (parent_id relationships)
-- - New memory types: action, strategy, reflection, system_event, reminder, note
-- - Status tracking: active, pending, blocked, completed, archived
-- - Weighted memory with priority scores
-- - Self-healing execution support (retry_count, last_error)
-- - Flexible metadata storage
-- - Helper RPCs for agent operations

-- ============================================================
-- 1. EXTEND TYPE CONSTRAINT
-- ============================================================
-- First drop the constraint, then recreate with expanded types
ALTER TABLE global_memory DROP CONSTRAINT IF EXISTS global_memory_type_check;

-- Add new columns first (all IF NOT EXISTS for idempotency)
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES global_memory(id) ON DELETE CASCADE;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'pending', 'blocked', 'completed', 'archived'));
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS weight FLOAT DEFAULT 1.0;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Now add the expanded type constraint
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

-- ============================================================
-- 2. CREATE INDEXES FOR NEW QUERY PATTERNS
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_global_memory_status ON global_memory(status);
CREATE INDEX IF NOT EXISTS idx_global_memory_parent ON global_memory(parent_id);
CREATE INDEX IF NOT EXISTS idx_global_memory_pending_actions
  ON global_memory(priority DESC, created_at ASC)
  WHERE type = 'action' AND status IN ('active', 'pending');
CREATE INDEX IF NOT EXISTS idx_global_memory_blocked
  ON global_memory(created_at DESC)
  WHERE status = 'blocked';
CREATE INDEX IF NOT EXISTS idx_global_memory_active_goals_hierarchy
  ON global_memory(priority DESC, created_at ASC)
  WHERE type = 'goal' AND status = 'active' AND parent_id IS NULL;

-- ============================================================
-- 3. CREATE MEMORY VIEW FOR COMPATIBILITY
-- ============================================================
-- Create a view named 'memory' that mirrors global_memory
-- This allows the agent code to use either table name
CREATE OR REPLACE VIEW memory AS SELECT * FROM global_memory;

-- Make the view updatable by creating rules
CREATE OR REPLACE RULE memory_insert AS ON INSERT TO memory
  DO INSTEAD INSERT INTO global_memory VALUES (NEW.*);

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
-- 4. HELPER RPCs FOR AGENT OPERATIONS
-- ============================================================

-- Get pending actions ordered by priority
CREATE OR REPLACE FUNCTION get_pending_actions(limit_count INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  content TEXT,
  priority INTEGER,
  parent_id UUID,
  retry_count INTEGER,
  status TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.priority,
    gm.parent_id,
    gm.retry_count,
    gm.status,
    gm.created_at
  FROM global_memory gm
  WHERE gm.type = 'action'
    AND gm.status IN ('active', 'pending')
  ORDER BY gm.priority DESC NULLS LAST, gm.created_at ASC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get strategies and reflections for agent reasoning
CREATE OR REPLACE FUNCTION get_strategy_context()
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    gm.created_at
  FROM global_memory gm
  WHERE gm.type IN ('strategy', 'reflection')
    AND gm.status = 'active'
  ORDER BY gm.created_at DESC
  LIMIT 20;
END;
$$ LANGUAGE plpgsql;

-- Get strategies only (for planning)
CREATE OR REPLACE FUNCTION get_strategies()
RETURNS TABLE (
  id UUID,
  content TEXT,
  created_at TIMESTAMPTZ,
  weight FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.created_at,
    gm.weight
  FROM global_memory gm
  WHERE gm.type = 'strategy' AND gm.status = 'active'
  ORDER BY gm.weight DESC NULLS LAST, gm.created_at DESC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql;

-- Get recent reflections
CREATE OR REPLACE FUNCTION get_reflections(limit_count INTEGER DEFAULT 5)
RETURNS TABLE (
  id UUID,
  content TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.created_at
  FROM global_memory gm
  WHERE gm.type = 'reflection' AND gm.status = 'active'
  ORDER BY gm.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get goals with their sub-goal counts
CREATE OR REPLACE FUNCTION get_active_goals_with_children()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER,
  status TEXT,
  parent_id UUID,
  child_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.deadline,
    gm.priority,
    gm.status,
    gm.parent_id,
    (SELECT COUNT(*) FROM global_memory sub WHERE sub.parent_id = gm.id) as child_count
  FROM global_memory gm
  WHERE gm.type = 'goal'
    AND gm.status != 'completed'
    AND gm.status != 'archived'
  ORDER BY
    CASE WHEN gm.parent_id IS NULL THEN 0 ELSE 1 END,
    gm.priority DESC NULLS LAST,
    gm.deadline ASC NULLS LAST,
    gm.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get goal hierarchy (goal with all children)
CREATE OR REPLACE FUNCTION get_goal_hierarchy()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER,
  parent_id UUID,
  status TEXT,
  sub_goal_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.deadline,
    gm.priority,
    gm.parent_id,
    gm.status,
    (SELECT COUNT(*) FROM global_memory sub WHERE sub.parent_id = gm.id) as sub_goal_count
  FROM global_memory gm
  WHERE gm.type = 'goal'
    AND gm.status = 'active'
  ORDER BY
    CASE WHEN gm.parent_id IS NULL THEN 0 ELSE 1 END,
    gm.priority DESC NULLS LAST,
    gm.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get agent system state
CREATE OR REPLACE FUNCTION get_agent_state()
RETURNS TABLE (
  active_goals BIGINT,
  pending_actions BIGINT,
  blocked_items BIGINT,
  recent_errors BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM global_memory WHERE type = 'goal' AND status IN ('active', 'pending')) as active_goals,
    (SELECT COUNT(*) FROM global_memory WHERE type = 'action' AND status IN ('pending', 'active')) as pending_actions,
    (SELECT COUNT(*) FROM global_memory WHERE status = 'blocked') as blocked_items,
    (SELECT COUNT(*) FROM logs_v2 WHERE level = 'error' AND created_at > NOW() - INTERVAL '24 hours') as recent_errors;
END;
$$ LANGUAGE plpgsql;

-- Mark an action as blocked
CREATE OR REPLACE FUNCTION mark_action_blocked(
  p_id UUID,
  p_error TEXT
)
RETURNS VOID AS $$
BEGIN
  UPDATE global_memory
  SET
    status = 'blocked',
    last_error = p_error,
    retry_count = retry_count + 1,
    metadata = jsonb_set(
      COALESCE(metadata, '{}'),
      '{blocked_at}',
      to_jsonb(NOW())
    )
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

-- Mark an action as completed
CREATE OR REPLACE FUNCTION mark_action_completed(p_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE global_memory
  SET
    status = 'completed',
    completed_at = NOW()
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

-- Complete a goal and cascade to children
CREATE OR REPLACE FUNCTION complete_goal_cascade(goal_id UUID)
RETURNS VOID AS $$
BEGIN
  -- Mark the goal complete
  UPDATE global_memory
  SET type = 'completed_goal',
      status = 'completed',
      completed_at = NOW()
  WHERE id = goal_id;

  -- Mark all children (sub-goals, actions) as completed
  UPDATE global_memory
  SET status = 'completed',
      completed_at = NOW()
  WHERE parent_id = goal_id;
END;
$$ LANGUAGE plpgsql;

-- Block a goal with a reason
CREATE OR REPLACE FUNCTION block_goal(
  goal_id UUID,
  reason TEXT
)
RETURNS VOID AS $$
BEGIN
  UPDATE global_memory
  SET status = 'blocked',
      metadata = jsonb_set(
        COALESCE(metadata, '{}'),
        '{blocked_reason}',
        to_jsonb(reason)
      )
  WHERE id = goal_id;
END;
$$ LANGUAGE plpgsql;

-- Decompose a goal (create sub-goal or action)
CREATE OR REPLACE FUNCTION decompose_goal(
  parent_goal_id UUID,
  item_type TEXT,
  item_content TEXT,
  item_priority INTEGER DEFAULT 3
)
RETURNS UUID AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO global_memory (type, content, priority, parent_id, status)
  VALUES (item_type, item_content, item_priority, parent_goal_id, 'active')
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- Log a system event
CREATE OR REPLACE FUNCTION log_system_event(
  event_content TEXT,
  event_metadata JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO global_memory (type, content, metadata, status)
  VALUES ('system_event', event_content, event_metadata, 'active')
  RETURNING id INTO new_id;

  -- Also log to logs_v2
  INSERT INTO logs_v2 (level, event, message, metadata)
  VALUES (
    COALESCE(event_metadata->>'level', 'info'),
    'agent_event',
    event_content,
    event_metadata
  );

  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- Weighted memory search
CREATE OR REPLACE FUNCTION search_weighted_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.6,
  match_count INT DEFAULT 15
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  status TEXT,
  similarity FLOAT,
  type_weight FLOAT,
  recency_weight FLOAT,
  final_score FLOAT
) AS $$
DECLARE
  rec_half_life_days FLOAT := 30.0;
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    gm.status,
    (1 - (gm.embedding <=> query_embedding)) AS similarity,
    CASE gm.type
      WHEN 'strategy' THEN 2.5
      WHEN 'goal' THEN 2.0
      WHEN 'action' THEN 1.8
      WHEN 'preference' THEN 1.5
      WHEN 'fact' THEN 1.0
      WHEN 'reflection' THEN 0.8
      WHEN 'completed_goal' THEN 0.3
      ELSE 1.0
    END AS type_weight,
    EXP(-EXTRACT(DAY FROM NOW() - gm.created_at) / rec_half_life_days) AS recency_weight,
    (1 - (gm.embedding <=> query_embedding)) *
    CASE gm.type
      WHEN 'strategy' THEN 2.5
      WHEN 'goal' THEN 2.0
      WHEN 'action' THEN 1.8
      WHEN 'preference' THEN 1.5
      WHEN 'fact' THEN 1.0
      WHEN 'reflection' THEN 0.8
      WHEN 'completed_goal' THEN 0.3
      ELSE 1.0
    END *
    COALESCE(gm.weight, 1.0) *
    EXP(-EXTRACT(DAY FROM NOW() - gm.created_at) / rec_half_life_days) AS final_score
  FROM global_memory gm
  WHERE gm.embedding IS NOT NULL
    AND (1 - (gm.embedding <=> query_embedding)) > match_threshold
    AND gm.status IN ('active', 'pending')
  ORDER BY final_score DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. AGENT LOOP STATE TABLE
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
ON CONFLICT (loop_type) WHERE loop_type = 'main' DO NOTHING;

ALTER TABLE agent_loop_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON agent_loop_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 6. LOG MIGRATION
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Unified autonomous agent schema v2.4 applied',
  '{"version": "20260216150000", "features": ["memory_view", "hierarchical_goals", "new_types", "weighted_memory", "agent_loop_state", "agent_rpcs"]}'::jsonb
);
