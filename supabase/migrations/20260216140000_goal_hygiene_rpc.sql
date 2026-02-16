-- Goal Hygiene RPC
-- Identifies duplicates, stale items, and malformed goals/actions
-- Uses global_memory table directly for compatibility
-- Note: Uses created_at since global_memory doesn't have updated_at column

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
  -- Find potential duplicates (same first 50 chars, same type)
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

  -- Find stale items (not created/modified in N days)
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

  -- Find malformed entries (empty content, missing type, etc.)
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

  -- Find orphan actions (no parent_id, not linked to any goal)
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

  -- Find blocked items overdue for review (blocked > 7 days)
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

  -- Build result
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

-- Helper RPC: Archive stale items
CREATE OR REPLACE FUNCTION archive_stale_items(
  p_days_stale INT DEFAULT 7,
  p_dry_run BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  affected_count INT;
  archived_ids UUID[];
BEGIN
  -- Get IDs of stale items
  SELECT array_agg(id) INTO archived_ids
  FROM global_memory
  WHERE status IN ('active', 'pending')
    AND created_at < NOW() - (p_days_stale || ' days')::interval;

  IF p_dry_run THEN
    SELECT COUNT(*) INTO affected_count
    FROM global_memory
    WHERE status IN ('active', 'pending')
      AND created_at < NOW() - (p_days_stale || ' days')::interval;

    RETURN jsonb_build_object(
      'dry_run', true,
      'would_archive_count', affected_count,
      'would_archive_ids', archived_ids,
      'message', 'Run with p_dry_run=false to actually archive'
    );
  END IF;

  -- Actually archive
  UPDATE global_memory
  SET status = 'archived'
  WHERE id = ANY(archived_ids);

  GET DIAGNOSTICS affected_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'dry_run', false,
    'archived_count', affected_count,
    'archived_ids', archived_ids
  );
END;
$$ LANGUAGE plpgsql;

-- Helper RPC: Delete malformed entries
CREATE OR REPLACE FUNCTION delete_malformed_entries(
  p_dry_run BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  affected_count INT;
  deleted_ids UUID[];
BEGIN
  -- Get IDs of malformed entries
  SELECT array_agg(id) INTO deleted_ids
  FROM global_memory
  WHERE content IS NULL
     OR content = ''
     OR content LIKE ']`%'
     OR content LIKE '%`[%'
     OR type IS NULL;

  IF p_dry_run THEN
    SELECT COUNT(*) INTO affected_count
    FROM global_memory
    WHERE content IS NULL
       OR content = ''
       OR content LIKE ']`%'
       OR content LIKE '%`[%'
       OR type IS NULL;

    RETURN jsonb_build_object(
      'dry_run', true,
      'would_delete_count', affected_count,
      'would_delete_ids', deleted_ids,
      'message', 'Run with p_dry_run=false to actually delete'
    );
  END IF;

  -- Actually delete
  DELETE FROM global_memory
  WHERE id = ANY(deleted_ids);

  GET DIAGNOSTICS affected_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'dry_run', false,
    'deleted_count', affected_count,
    'deleted_ids', deleted_ids
  );
END;
$$ LANGUAGE plpgsql;

-- Helper RPC: Merge duplicates (keep newest, archive others)
CREATE OR REPLACE FUNCTION merge_duplicate_goals(
  p_dry_run BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  WITH duplicate_groups AS (
    SELECT
      SUBSTRING(LOWER(content), 1, 50) as content_key,
      array_agg(id ORDER BY created_at DESC) as ids,
      COUNT(*) as cnt
    FROM global_memory
    WHERE type = 'goal' AND status = 'active'
    GROUP BY SUBSTRING(LOWER(content), 1, 50)
    HAVING COUNT(*) > 1
  )
  SELECT jsonb_agg(jsonb_build_object(
    'content_key', content_key,
    'keep_id', ids[1],
    'archive_ids', ids[2:array_length(ids, 1)],
    'count', cnt
  )) INTO result
  FROM duplicate_groups;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', true,
      'duplicates_found', COALESCE(jsonb_array_length(result), 0),
      'groups', COALESCE(result, '[]'::jsonb),
      'message', 'Run with p_dry_run=false to actually merge'
    );
  END IF;

  -- Actually merge (archive older duplicates)
  WITH duplicate_groups AS (
    SELECT
      SUBSTRING(LOWER(content), 1, 50) as content_key,
      array_agg(id ORDER BY created_at DESC) as ids
    FROM global_memory
    WHERE type = 'goal' AND status = 'active'
    GROUP BY SUBSTRING(LOWER(content), 1, 50)
    HAVING COUNT(*) > 1
  )
  UPDATE global_memory
  SET status = 'archived'
  WHERE id IN (
    SELECT unnest(ids[2:array_length(ids, 1)])
    FROM duplicate_groups
  );

  RETURN jsonb_build_object(
    'dry_run', false,
    'merged_groups', COALESCE(jsonb_array_length(result), 0),
    'details', COALESCE(result, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION goal_hygiene IS 'Identifies memory hygiene issues: duplicates, stale items, malformed entries';
COMMENT ON FUNCTION archive_stale_items IS 'Archives items not modified in N days (based on created_at)';
COMMENT ON FUNCTION delete_malformed_entries IS 'Deletes entries with malformed content';
COMMENT ON FUNCTION merge_duplicate_goals IS 'Merges duplicate goals by archiving older copies';
