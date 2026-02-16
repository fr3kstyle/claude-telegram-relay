-- ============================================================
-- Fix: match_memory to search memory table
-- ============================================================
-- The original match_memory searched global_memory but
-- the autonomous agent uses memory table.
-- This updates it to search memory table.

CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  similarity FLOAT
) AS $$
BEGIN
  -- Try memory table first
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND m.status = 'active'
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;

  -- If no results, the RETURN QUERY above returns empty
  -- which is fine - caller can try global_memory
END;
$$ LANGUAGE plpgsql;

-- Also create one for global_memory
CREATE OR REPLACE FUNCTION match_global_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    1 - (gm.embedding <=> query_embedding) AS similarity
  FROM global_memory gm
  WHERE gm.embedding IS NOT NULL
    AND 1 - (gm.embedding <=> query_embedding) > match_threshold
  ORDER BY gm.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Log migration
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Fixed match_memory to search memory table',
  '{"version": "20260216120000"}'::jsonb
)
ON CONFLICT DO NOTHING;
