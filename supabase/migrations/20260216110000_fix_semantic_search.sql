-- ============================================================
-- Schema v3.1: Fix Semantic Search for Autonomous Agent
-- ============================================================
-- Creates unified search functions that work with both
-- global_memory (original) and memory (new agent) tables.
-- Provides graceful fallback when tables don't exist.

-- ============================================================
-- RPC: match_memory_unified()
-- ============================================================
-- Searches both global_memory and memory tables for embeddings.
-- Returns unified results with source table indication.
CREATE OR REPLACE FUNCTION match_memory_unified(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.6,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  similarity FLOAT,
  source_table TEXT
) AS $$
BEGIN
  -- Try global_memory first (original table)
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    1 - (gm.embedding <=> query_embedding) AS similarity,
    'global_memory'::TEXT AS source_table
  FROM global_memory gm
  WHERE gm.embedding IS NOT NULL
    AND 1 - (gm.embedding <=> query_embedding) > match_threshold

  UNION ALL

  -- Then memory table (new agent table)
  SELECT
    m.id,
    m.content,
    m.type,
    1 - (m.embedding <=> query_embedding) AS similarity,
    'memory'::TEXT AS source_table
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold

  ORDER BY similarity DESC
  LIMIT match_count;

EXCEPTION WHEN undefined_table THEN
  -- If memory table doesn't exist, just search global_memory
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    1 - (gm.embedding <=> query_embedding) AS similarity,
    'global_memory'::TEXT AS source_table
  FROM global_memory gm
  WHERE gm.embedding IS NOT NULL
    AND 1 - (gm.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: match_memory() - Enhanced
-- ============================================================
-- Update the original match_memory to include more memory types
-- and work with the extended type constraint.
DROP FUNCTION IF EXISTS match_memory(VECTOR(1536), FLOAT, INT);

CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.6,
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
    -- Include all active types (not just fact/goal)
    AND gm.type IN ('fact', 'goal', 'preference', 'strategy', 'action', 'reflection')
  ORDER BY gm.embedding <=> query_embedding
  LIMIT match_count;

EXCEPTION WHEN others THEN
  -- Return empty on any error
  RETURN QUERY SELECT
    NULL::UUID AS id,
    NULL::TEXT AS content,
    NULL::TEXT AS type,
    0.0::FLOAT AS similarity
  WHERE FALSE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: backfill_embeddings()
-- ============================================================
-- Helper to backfill embeddings for existing memories.
-- Returns count of items needing embeddings.
CREATE OR REPLACE FUNCTION get_unembedded_count()
RETURNS INTEGER AS $$
DECLARE
  global_count INTEGER;
  memory_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO global_count
  FROM global_memory WHERE embedding IS NULL;

  SELECT COUNT(*) INTO memory_count
  FROM memory WHERE embedding IS NULL
  WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'memory');

  RETURN COALESCE(global_count, 0) + COALESCE(memory_count, 0);
EXCEPTION WHEN undefined_table THEN
  RETURN COALESCE(global_count, 0);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- UPDATE SEARCH EDGE FUNCTION CONFIG
-- ============================================================
-- Note: The Edge Function will need to be updated to use
-- match_memory_unified() for best results.
-- For now, match_memory() is enhanced to include more types.

-- Log migration
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Semantic search fix applied',
  '{"version": "20260216110000", "features": ["unified_search", "enhanced_match_memory", "backfill_helper"]}'::jsonb
)
ON CONFLICT DO NOTHING;
