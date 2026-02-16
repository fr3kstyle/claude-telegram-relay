-- ============================================================
-- Schema v3: Autonomous Agent System
-- ============================================================
-- Extends memory types to support: action, strategy, reflection, system_event
-- Adds hierarchical relationships (parent_id), status tracking, and weights
-- Creates helper RPCs for agent loop operations

-- ============================================================
-- EXTEND MEMORY TYPE CHECK
-- ============================================================
-- First drop the constraint, then add with expanded types
ALTER TABLE memory DROP CONSTRAINT IF EXISTS memory_type_check;
ALTER TABLE memory ADD CONSTRAINT memory_type_check
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

-- Also update global_memory if it exists
ALTER TABLE global_memory DROP CONSTRAINT IF EXISTS global_memory_type_check;
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
-- ADD NEW COLUMNS
-- ============================================================
-- parent_id: for hierarchical goals (sub-goals, actions belonging to goals)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES memory(id) ON DELETE CASCADE;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES global_memory(id) ON DELETE CASCADE;

-- status: track lifecycle (active, pending, blocked, completed, archived)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'pending', 'blocked', 'completed', 'archived'));
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'pending', 'blocked', 'completed', 'archived'));

-- weight: importance scoring for weighted recall
ALTER TABLE memory ADD COLUMN IF NOT EXISTS weight FLOAT DEFAULT 1.0;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS weight FLOAT DEFAULT 1.0;

-- ============================================================
-- INDEXES FOR NEW COLUMNS
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_memory_parent_id ON memory(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory(status);
CREATE INDEX IF NOT EXISTS idx_memory_type_status ON memory(type, status);

CREATE INDEX IF NOT EXISTS idx_global_memory_parent_id ON global_memory(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_global_memory_status ON global_memory(status);

-- ============================================================
-- RPC: get_active_goals_with_children()
-- ============================================================
-- Returns goals with counts of child items (sub-goals + actions)
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
    m.id,
    m.content,
    m.deadline,
    m.priority,
    m.status,
    m.parent_id,
    (SELECT COUNT(*) FROM memory c WHERE c.parent_id = m.id) as child_count
  FROM memory m
  WHERE m.type = 'goal' AND m.status != 'completed' AND m.status != 'archived'
  ORDER BY m.priority DESC NULLS LAST, m.deadline ASC NULLS LAST, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get_pending_actions()
-- ============================================================
-- Returns actions that are pending execution
CREATE OR REPLACE FUNCTION get_pending_actions()
RETURNS TABLE (
  id UUID,
  content TEXT,
  priority INTEGER,
  status TEXT,
  parent_id UUID
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.priority,
    m.status,
    m.parent_id
  FROM memory m
  WHERE m.type = 'action' AND m.status IN ('pending', 'active')
  ORDER BY m.priority DESC NULLS LAST, m.created_at ASC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get_strategies()
-- ============================================================
-- Returns active strategies for planning
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
    m.id,
    m.content,
    m.created_at,
    m.weight
  FROM memory m
  WHERE m.type = 'strategy' AND m.status = 'active'
  ORDER BY m.weight DESC NULLS LAST, m.created_at DESC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get_reflections()
-- ============================================================
-- Returns recent reflections for context
CREATE OR REPLACE FUNCTION get_reflections(limit_count INTEGER DEFAULT 5)
RETURNS TABLE (
  id UUID,
  content TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.created_at
  FROM memory m
  WHERE m.type = 'reflection'
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get_agent_state()
-- ============================================================
-- Returns overall system state for agent decision-making
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
    (SELECT COUNT(*) FROM memory WHERE type = 'goal' AND status IN ('active', 'pending')) as active_goals,
    (SELECT COUNT(*) FROM memory WHERE type = 'action' AND status = 'pending') as pending_actions,
    (SELECT COUNT(*) FROM memory WHERE status = 'blocked') as blocked_items,
    (SELECT COUNT(*) FROM logs WHERE level = 'error' AND created_at > NOW() - INTERVAL '24 hours') as recent_errors;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: log_system_event()
-- ============================================================
-- Logs a system event from the agent
CREATE OR REPLACE FUNCTION log_system_event(
  event_content TEXT,
  event_metadata JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO memory (type, content, metadata, status)
  VALUES ('system_event', event_content, event_metadata, 'active')
  RETURNING id INTO new_id;

  -- Also log to logs table if it exists
  INSERT INTO logs (level, event, message, metadata)
  SELECT
    COALESCE(event_metadata->>'level', 'info'),
    'agent_event',
    event_content,
    event_metadata
  WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'logs');

  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: complete_goal_cascade()
-- ============================================================
-- Marks a goal complete and cascades to children
CREATE OR REPLACE FUNCTION complete_goal_cascade(goal_id UUID)
RETURNS VOID AS $$
BEGIN
  -- Mark the goal complete
  UPDATE memory
  SET type = 'completed_goal',
      status = 'completed',
      completed_at = NOW()
  WHERE id = goal_id;

  -- Mark all children (sub-goals, actions) as completed
  UPDATE memory
  SET status = 'completed',
      completed_at = NOW()
  WHERE parent_id = goal_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: block_goal()
-- ============================================================
-- Marks a goal as blocked with a reason
CREATE OR REPLACE FUNCTION block_goal(
  goal_id UUID,
  reason TEXT
)
RETURNS VOID AS $$
BEGIN
  UPDATE memory
  SET status = 'blocked',
      metadata = jsonb_set(
        COALESCE(metadata, '{}'),
        '{blocked_reason}',
        to_jsonb(reason)
      )
  WHERE id = goal_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: decompose_goal()
-- ============================================================
-- Creates sub-goals or actions under a parent goal
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
  INSERT INTO memory (type, content, priority, parent_id, status)
  VALUES (item_type, item_content, item_priority, parent_goal_id, 'active')
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- WEIGHTED MEMORY SEARCH
-- ============================================================
-- Enhanced search with type weights and recency decay
CREATE OR REPLACE FUNCTION search_weighted_memory(
  query_embedding VECTOR(1536),
  match_count INTEGER DEFAULT 15
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  status TEXT,
  final_score FLOAT,
  similarity FLOAT
) AS $$
DECLARE
  type_weights JSONB DEFAULT '{
    "goal": 2.0,
    "strategy": 2.5,
    "action": 1.8,
    "preference": 1.5,
    "fact": 1.0,
    "reflection": 1.3,
    "completed_goal": 0.3
  }';
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.status,
    -- Final score = similarity * type_weight * recency_weight * priority_weight
    (
      (1 - (m.embedding <=> query_embedding)) *
      COALESCE((type_weights->>m.type)::FLOAT, 1.0) *
      m.weight *
      (1 + m.priority / 10.0)
    ) as final_score,
    (1 - (m.embedding <=> query_embedding)) as similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND m.status != 'archived'
  ORDER BY final_score DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
