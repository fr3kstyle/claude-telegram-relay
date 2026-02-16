-- Self-Improvement Extensions Migration
-- Run in Supabase SQL Editor

-- Reflections table (for Reflexion Pattern)
CREATE TABLE IF NOT EXISTS reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failure_context TEXT NOT NULL,
  failure_type TEXT NOT NULL CHECK (failure_type IN ('memory_op', 'api_call', 'reasoning', 'execution', 'other')),
  analysis TEXT,
  lessons_learned TEXT[] DEFAULT '{}',
  improved_strategy TEXT,
  confidence FLOAT DEFAULT 0.5,
  applied_count INT DEFAULT 0,
  success_rate FLOAT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Experience Replay table
CREATE TABLE IF NOT EXISTS experience_replay (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('success', 'failure', 'neutral')),
  category TEXT NOT NULL CHECK (category IN ('memory', 'reasoning', 'execution', 'communication', 'scheduling')),
  context TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT,
  lessons TEXT[] DEFAULT '{}',
  replay_count INT DEFAULT 0,
  last_replay TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_reflections_type ON reflections(failure_type);
CREATE INDEX IF NOT EXISTS idx_reflections_confidence ON reflections(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_experience_type ON experience_replay(type);
CREATE INDEX IF NOT EXISTS idx_experience_category ON experience_replay(category);

-- RPC: Get improvement summary
CREATE OR REPLACE FUNCTION get_improvement_summary()
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'reflections_count', (SELECT COUNT(*) FROM reflections),
    'experiences_count', (SELECT COUNT(*) FROM experience_replay),
    'ab_tests_active', (SELECT COUNT(*) FROM self_improvement_tests WHERE status = 'running'),
    'recent_failures', (SELECT COUNT(*) FROM improvement_logs WHERE type = 'failure' AND created_at > NOW() - INTERVAL '7 days'),
    'recent_successes', (SELECT COUNT(*) FROM improvement_logs WHERE type = 'success' AND created_at > NOW() - INTERVAL '7 days')
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE reflections IS 'Stores failure analysis and lessons learned for self-correction';
COMMENT ON TABLE experience_replay IS 'Stores experiences for pattern learning across sessions';
