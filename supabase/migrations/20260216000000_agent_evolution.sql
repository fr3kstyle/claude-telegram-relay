-- ============================================================
-- Schema v3: Autonomous Agent Evolution
-- ============================================================
-- Extends memory system for autonomous agent capabilities:
-- - Hierarchical goals (parent_id relationships)
-- - New memory types: action, strategy, reflection, system_event
-- - Status tracking: active, pending, blocked, completed, archived
-- - Weighted memory with priority scores
-- - Sub-goal decomposition support
-- Part of Milestone v2.0: Autonomous Operator Edition.

-- ============================================================
-- DROP AND RECREATE TYPE CONSTRAINT
-- ============================================================
-- First drop the constraint, then modify columns, then recreate
ALTER TABLE global_memory DROP CONSTRAINT IF EXISTS global_memory_type_check;

-- ============================================================
-- ADD NEW COLUMNS
-- ============================================================

-- parent_id: For hierarchical goals and sub-task relationships
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES global_memory(id) ON DELETE CASCADE;

-- status: Track lifecycle state of goals/actions
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'pending', 'blocked', 'completed', 'archived'));

-- weight: Custom weight for memory scoring (higher = more important)
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS weight FLOAT DEFAULT 1.0;

-- retry_count: For self-healing execution (track failed attempts)
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- last_error: Store last error message for blocked items
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS last_error TEXT;

-- metadata: JSON column for flexible agent data
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- ============================================================
-- UPDATE TYPE CONSTRAINT WITH NEW TYPES
-- ============================================================
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
-- INDEXES FOR NEW QUERY PATTERNS
-- ============================================================

-- Fast lookup by status
CREATE INDEX IF NOT EXISTS idx_global_memory_status ON global_memory(status);

-- Fast lookup of pending actions for agent loop
CREATE INDEX IF NOT EXISTS idx_global_memory_pending_actions
  ON global_memory(priority DESC, created_at ASC)
  WHERE type = 'action' AND status IN ('active', 'pending');

-- Fast lookup of blocked items for retry
CREATE INDEX IF NOT EXISTS idx_global_memory_blocked
  ON global_memory(updated_at DESC)
  WHERE status = 'blocked';

-- Parent-child relationships
CREATE INDEX IF NOT EXISTS idx_global_memory_parent ON global_memory(parent_id);

-- Hierarchical goals query
CREATE INDEX IF NOT EXISTS idx_global_memory_active_goals_hierarchy
  ON global_memory(priority DESC, created_at ASC)
  WHERE type = 'goal' AND status = 'active' AND parent_id IS NULL;

-- ============================================================
-- RPC: get_pending_actions()
-- ============================================================
-- Returns actions that need execution, ordered by priority.
CREATE OR REPLACE FUNCTION get_pending_actions(limit_count INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  content TEXT,
  priority INTEGER,
  parent_id UUID,
  retry_count INTEGER,
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
    gm.created_at
  FROM global_memory gm
  WHERE gm.type = 'action'
    AND gm.status IN ('active', 'pending')
  ORDER BY gm.priority DESC NULLS LAST, gm.created_at ASC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get_strategy_context()
-- ============================================================
-- Returns strategies and reflections for agent reasoning.
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

-- ============================================================
-- RPC: get_goal_hierarchy()
-- ============================================================
-- Returns goals with their sub-goals for decomposition view.
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

-- ============================================================
-- RPC: mark_action_blocked()
-- ============================================================
-- Marks an action as blocked with error info.
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
    updated_at = NOW()
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: mark_action_completed()
-- ============================================================
-- Marks an action as completed.
CREATE OR REPLACE FUNCTION mark_action_completed(p_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE global_memory
  SET
    status = 'completed',
    updated_at = NOW()
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: weighted_memory_search()
-- ============================================================
-- Weighted memory search combining semantic similarity with type/recency weights.
CREATE OR REPLACE FUNCTION weighted_memory_search(
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
    -- Type weights
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
    -- Recency weight (exponential decay)
    EXP(-EXTRACT(DAY FROM NOW() - gm.created_at) / rec_half_life_days) AS recency_weight,
    -- Final score
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
-- AGENT LOOP STATE TABLE
-- ============================================================
-- Track autonomous agent loop state and history.

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

-- Ensure only one main loop state
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_loop_state_main
  ON agent_loop_state(loop_type) WHERE loop_type = 'main';

-- Insert default state if not exists
INSERT INTO agent_loop_state (loop_type, status)
VALUES ('main', 'idle')
ON CONFLICT (loop_type) WHERE loop_type = 'main' DO NOTHING;

-- ============================================================
-- LOG MIGRATION VERIFICATION
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Agent evolution schema v3 applied',
  '{"version": "20260216000000", "features": ["hierarchical_goals", "new_types", "weighted_memory", "agent_loop_state"]}'::jsonb
);
