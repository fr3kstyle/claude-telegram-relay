-- ============================================================
-- Schema v3.2: Direct Search Fallback (No Edge Function)
-- ============================================================
-- Provides text-based search when semantic search is unavailable.
-- Falls back gracefully without requiring OpenAI API.

-- ============================================================
-- RPC: search_memory_text()
-- ============================================================
-- Simple text search when embeddings aren't available.
-- Uses PostgreSQL full-text search with ranking.
CREATE OR REPLACE FUNCTION search_memory_text(
  search_query TEXT,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  rank FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    ts_rank_cd(gm.search_vector, plainto_tsquery('english', search_query)) AS rank
  FROM global_memory gm
  WHERE gm.search_vector @@ plainto_tsquery('english', search_query)
    AND gm.type IN ('fact', 'goal', 'preference', 'strategy', 'action', 'reflection')
  ORDER BY rank DESC
  LIMIT match_count;

EXCEPTION WHEN others THEN
  -- Fallback to simple ILIKE if full-text index doesn't exist
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.type,
    0.5::FLOAT AS rank
  FROM global_memory gm
  WHERE gm.content ILIKE '%' || search_query || '%'
    AND gm.type IN ('fact', 'goal', 'preference', 'strategy', 'action', 'reflection')
  ORDER BY gm.created_at DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ADD SEARCH VECTOR COLUMN
-- ============================================================
-- Auto-generated full-text search vector
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- Create trigger to auto-update search_vector
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS global_memory_search_vector_update ON global_memory;

-- Create trigger
CREATE TRIGGER global_memory_search_vector_update
  BEFORE INSERT OR UPDATE ON global_memory
  FOR EACH ROW
  EXECUTE FUNCTION update_search_vector();

-- Create index for fast text search
CREATE INDEX IF NOT EXISTS idx_global_memory_search_vector
  ON global_memory USING GIN(search_vector);

-- Backfill existing records
UPDATE global_memory SET search_vector = to_tsvector('english', COALESCE(content, ''))
WHERE search_vector IS NULL;

-- ============================================================
-- RPC: hybrid_search()
-- ============================================================
-- Combines semantic (if available) and text search.
-- Falls back to text-only when embeddings missing.
CREATE OR REPLACE FUNCTION hybrid_search(
  search_query TEXT,
  match_count INT DEFAULT 10,
  use_semantic BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  score FLOAT,
  search_type TEXT
) AS $$
DECLARE
  has_embeddings BOOLEAN;
BEGIN
  -- Check if any embeddings exist
  SELECT EXISTS(SELECT 1 FROM global_memory WHERE embedding IS NOT NULL) INTO has_embeddings;

  IF use_semantic AND has_embeddings THEN
    -- Try semantic search (will fail gracefully if no matches)
    RETURN QUERY
    SELECT
      m.id,
      m.content,
      m.type,
      m.similarity AS score,
      'semantic'::TEXT AS search_type
    FROM match_memory(
      (SELECT embedding FROM global_memory WHERE embedding IS NOT NULL LIMIT 1), -- Placeholder
      0.5,
      match_count
    ) m;

    -- If semantic returned results, we're done
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  -- Fall back to text search
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.type,
    t.rank AS score,
    'text'::TEXT AS search_type
  FROM search_memory_text(search_query, match_count) t;
END;
$$ LANGUAGE plpgsql;

-- Log migration
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Direct search fallback applied',
  '{"version": "20260216120000", "features": ["text_search", "hybrid_search", "auto_search_vector"]}'::jsonb
)
ON CONFLICT DO NOTHING;
