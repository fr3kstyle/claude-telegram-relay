-- ============================================================
-- MANUAL APPLY: Consolidated Schema Updates
-- ============================================================
-- Run this in Supabase Dashboard SQL Editor to update the schema
-- Generated: 2026-02-16
-- Combines: unified_autonomous_schema, goal_hygiene_rpc, missing columns

-- ============================================================
-- 1. ADD MISSING COLUMNS
-- ============================================================
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- ============================================================
-- 2. EXPAND TYPE CONSTRAINT
-- ============================================================
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
-- 3. CREATE AGENT LOOP STATE TABLE
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

INSERT INTO agent_loop_state (loop_type, status)
VALUES ('main', 'idle')
ON CONFLICT (loop_type) WHERE loop_type = 'main' DO NOTHING;

ALTER TABLE agent_loop_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service_role_all" ON agent_loop_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 4. CREATE ADDITIONAL INDEXES
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
-- 5. GOAL HYGIENE RPC
-- ============================================================
CREATE OR REPLACE FUNCTION goal_hygiene(
  p_days_stale INT DEFAULT 7,
  p_similarity_threshold FLOAT DEFAULT 0.8
)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
  duplicates JSONB;
  stale_items JSONB;
  malformed JSONB;
  orphan_actions JSONB;
  blocked_overdue JSONB;
BEGIN
  SELECT jsonb_agg(DISTINCT jsonb_build_object(
    'content_preview', duplicate_key,
    'count', cnt,
    'ids', ids
  )) INTO duplicates
  FROM (
    SELECT
      SUBSTRING(LOWER(content), 1, 50) as duplicate_key,
      COUNT(*) as cnt,
      jsonb_agg(id) as ids
    FROM global_memory
    WHERE status IN ('active', 'pending')
    GROUP BY SUBSTRING(LOWER(content), 1, 50)
    HAVING COUNT(*) > 1
  ) dupes;

  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'type', type,
    'content', SUBSTRING(content, 1, 80),
    'created_at', created_at,
    'days_old', EXTRACT(DAY FROM NOW() - created_at)::int
  )) INTO stale_items
  FROM global_memory
  WHERE status IN ('active', 'pending')
    AND created_at < NOW() - (p_days_stale || ' days')::interval
  ORDER BY created_at ASC
  LIMIT 50;

  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'type', type,
    'content', content,
    'issue', CASE
      WHEN content IS NULL OR content = '' THEN 'empty_content'
      WHEN content LIKE ']`%' THEN 'malformed_prefix'
      WHEN content LIKE '%`[%' THEN 'malformed_injection'
      WHEN type IS NULL THEN 'missing_type'
      ELSE 'unknown'
    END
  )) INTO malformed
  FROM global_memory
  WHERE content IS NULL
     OR content = ''
     OR content LIKE ']`%'
     OR content LIKE '%`[%'
     OR type IS NULL
  LIMIT 20;

  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'content', SUBSTRING(content, 1, 60),
    'priority', priority,
    'created_at', created_at
  )) INTO orphan_actions
  FROM global_memory
  WHERE type = 'action'
    AND status = 'pending'
    AND parent_id IS NULL
  ORDER BY priority ASC, created_at ASC
  LIMIT 50;

  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'type', type,
    'content', SUBSTRING(content, 1, 60),
    'status', status,
    'days_blocked', EXTRACT(DAY FROM NOW() - created_at)::int
  )) INTO blocked_overdue
  FROM global_memory
  WHERE status = 'blocked'
    AND created_at < NOW() - INTERVAL '7 days'
  ORDER BY created_at ASC
  LIMIT 30;

  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'total_active_goals', (SELECT COUNT(*) FROM global_memory WHERE type = 'goal' AND status = 'active'),
      'total_pending_actions', (SELECT COUNT(*) FROM global_memory WHERE type = 'action' AND status = 'pending'),
      'total_blocked', (SELECT COUNT(*) FROM global_memory WHERE status = 'blocked'),
      'total_archived', (SELECT COUNT(*) FROM global_memory WHERE status = 'archived')
    ),
    'duplicates', COALESCE(duplicates, '[]'::jsonb),
    'stale_items', COALESCE(stale_items, '[]'::jsonb),
    'malformed', COALESCE(malformed, '[]'::jsonb),
    'orphan_actions', COALESCE(orphan_actions, '[]'::jsonb),
    'blocked_overdue', COALESCE(blocked_overdue, '[]'::jsonb),
    'recommendations', jsonb_build_array(
      'Archive stale items older than ' || p_days_stale || ' days',
      'Merge or delete duplicate entries',
      'Delete malformed entries',
      'Link orphan actions to parent goals or delete',
      'Review blocked items: resolve or archive with notes'
    ),
    'generated_at', NOW()
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. LOG SUCCESS
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Consolidated schema updates applied manually',
  '{"version": "manual_apply_consolidated", "date": "2026-02-16", "changes": ["retry_count column", "last_error column", "metadata column", "expanded type constraint", "agent_loop_state table", "goal_hygiene rpc"]}'::jsonb
);
