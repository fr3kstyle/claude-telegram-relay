-- Self-Improvement System Tables
-- Run in Supabase SQL Editor

-- A/B Testing Table
CREATE TABLE IF NOT EXISTS self_improvement_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  variant_a TEXT NOT NULL,
  variant_b TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT 'success_rate',
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'paused')),
  results_a JSONB DEFAULT '{"successes": 0, "failures": 0, "total_value": 0}',
  results_b JSONB DEFAULT '{"successes": 0, "failures": 0, "total_value": 0}',
  winner TEXT CHECK (winner IN ('a', 'b', 'tie')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Metrics Tracking Table
CREATE TABLE IF NOT EXISTS improvement_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  value FLOAT NOT NULL,
  metadata JSONB,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Improvement Logs Table
CREATE TABLE IF NOT EXISTS improvement_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('insight', 'failure', 'success', 'experiment')),
  description TEXT NOT NULL,
  impact TEXT DEFAULT 'low' CHECK (impact IN ('low', 'medium', 'high')),
  action_taken TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_metrics_category_name ON improvement_metrics(category, name);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON improvement_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_type ON improvement_logs(type);
CREATE INDEX IF NOT EXISTS idx_logs_created ON improvement_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tests_status ON self_improvement_tests(status);

-- RPC: Get improvement dashboard data
CREATE OR REPLACE FUNCTION get_improvement_dashboard()
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'active_tests', (SELECT COUNT(*) FROM self_improvement_tests WHERE status = 'running'),
    'completed_tests', (SELECT COUNT(*) FROM self_improvement_tests WHERE status = 'completed'),
    'recent_failures', (SELECT COUNT(*) FROM improvement_logs WHERE type = 'failure' AND created_at > NOW() - INTERVAL '7 days'),
    'recent_successes', (SELECT COUNT(*) FROM improvement_logs WHERE type = 'success' AND created_at > NOW() - '7 days'::interval),
    'total_metrics', (SELECT COUNT(*) FROM improvement_metrics WHERE timestamp > NOW() - INTERVAL '30 days'),
    'test_win_rate', (
      SELECT COALESCE(
        (SELECT COUNT(*) FROM self_improvement_tests WHERE winner IS NOT NULL)::float /
        NULLIF((SELECT COUNT(*) FROM self_improvement_tests WHERE status = 'completed'), 0) * 100,
        0
      )
    )
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- RPC: Get metric trends
CREATE OR REPLACE FUNCTION get_metric_trends(
  p_category TEXT,
  p_name TEXT,
  p_days INT DEFAULT 30
)
RETURNS TABLE (
  date DATE,
  avg_value FLOAT,
  count INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE(timestamp) as date,
    AVG(value)::float as avg_value,
    COUNT(*)::int as count
  FROM improvement_metrics
  WHERE category = p_category
    AND name = p_name
    AND timestamp > NOW() - (p_days || ' days')::interval
  GROUP BY DATE(timestamp)
  ORDER BY date;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE self_improvement_tests IS 'A/B tests for continuous improvement';
COMMENT ON TABLE improvement_metrics IS 'Time-series metrics for performance tracking';
COMMENT ON TABLE improvement_logs IS 'Log of insights, failures, successes for learning';
