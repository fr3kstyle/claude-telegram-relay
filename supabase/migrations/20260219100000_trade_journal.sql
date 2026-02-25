-- Trade Journal Table
-- Records trades for learning and pattern analysis

CREATE TABLE IF NOT EXISTS trade_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DECIMAL(20, 8) NOT NULL,
  exit_price DECIMAL(20, 8) NOT NULL,
  size DECIMAL(20, 8) NOT NULL,
  leverage INTEGER NOT NULL DEFAULT 10,
  pnl DECIMAL(20, 8) NOT NULL,
  pnl_percent DECIMAL(10, 4) NOT NULL,
  entry_reason TEXT,
  exit_reason TEXT,
  signal_confidence INTEGER DEFAULT 50,
  market_trend TEXT DEFAULT 'sideways',
  market_volatility TEXT DEFAULT 'medium',
  market_volume TEXT DEFAULT 'normal',
  fear_greed_index INTEGER DEFAULT 50,
  lessons TEXT[] DEFAULT '{}',
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_trade_journal_symbol ON trade_journal(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_journal_closed_at ON trade_journal(closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_journal_pnl ON trade_journal(pnl);
CREATE INDEX IF NOT EXISTS idx_trade_journal_side ON trade_journal(side);

-- Enable RLS
ALTER TABLE trade_journal ENABLE ROW LEVEL SECURITY;

-- Policy for service role (full access)
CREATE POLICY "Service role can manage trade journal" ON trade_journal
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Policy for authenticated users (read only)
CREATE POLICY "Authenticated users can read trade journal" ON trade_journal
  FOR SELECT TO authenticated
  USING (true);

-- Function to get trading statistics
CREATE OR REPLACE FUNCTION get_trade_stats(
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  total_trades BIGINT,
  win_rate DECIMAL,
  avg_pnl DECIMAL,
  total_pnl DECIMAL,
  profit_factor DECIMAL,
  best_trade DECIMAL,
  worst_trade DECIMAL,
  avg_win DECIMAL,
  avg_loss DECIMAL
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as total_trades,
    COALESCE(AVG(CASE WHEN pnl > 0 THEN 100 ELSE 0 END), 0)::DECIMAL as win_rate,
    COALESCE(AVG(pnl), 0)::DECIMAL as avg_pnl,
    COALESCE(SUM(pnl), 0)::DECIMAL as total_pnl,
    CASE
      WHEN SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END) = 0 THEN
        CASE WHEN SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) > 0 THEN 999.99 ELSE 0 END
      ELSE
        SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) / SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END)
    END::DECIMAL as profit_factor,
    COALESCE(MAX(pnl), 0)::DECIMAL as best_trade,
    COALESCE(MIN(pnl), 0)::DECIMAL as worst_trade,
    COALESCE(AVG(CASE WHEN pnl > 0 THEN pnl END), 0)::DECIMAL as avg_win,
    COALESCE(AVG(CASE WHEN pnl < 0 THEN ABS(pnl) END), 0)::DECIMAL as avg_loss
  FROM trade_journal
  WHERE closed_at > NOW() - (p_days || ' days')::INTERVAL;
END;
$$;

-- Function to get performance by market condition
CREATE OR REPLACE FUNCTION get_performance_by_condition(
  p_condition TEXT,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  condition_value TEXT,
  trades BIGINT,
  wins BIGINT,
  losses BIGINT,
  win_rate DECIMAL,
  avg_pnl DECIMAL
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY EXECUTE format('
    SELECT
      CASE
        WHEN $1 = ''trend'' THEN market_trend
        WHEN $1 = ''volatility'' THEN market_volatility
        WHEN $1 = ''volume'' THEN market_volume
        ELSE ''unknown''
      END as condition_value,
      COUNT(*)::BIGINT as trades,
      COUNT(*) FILTER (WHERE pnl > 0)::BIGINT as wins,
      COUNT(*) FILTER (WHERE pnl < 0)::BIGINT as losses,
      COALESCE(AVG(CASE WHEN pnl > 0 THEN 100 ELSE 0 END), 0)::DECIMAL as win_rate,
      COALESCE(AVG(pnl), 0)::DECIMAL as avg_pnl
    FROM trade_journal
    WHERE closed_at > NOW() - ($2 || '' days'')::INTERVAL
    GROUP BY
      CASE
        WHEN $1 = ''trend'' THEN market_trend
        WHEN $1 = ''volatility'' THEN market_volatility
        WHEN $1 = ''volume'' THEN market_volume
        ELSE ''unknown''
      END
    ORDER BY win_rate DESC
  ') USING p_condition, p_days;
END;
$$;

-- Function to get best/worst performing symbols
CREATE OR REPLACE FUNCTION get_symbol_performance(
  p_min_trades INTEGER DEFAULT 3,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  symbol TEXT,
  trades BIGINT,
  win_rate DECIMAL,
  avg_pnl DECIMAL,
  total_pnl DECIMAL
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    tj.symbol,
    COUNT(*)::BIGINT as trades,
    COALESCE(AVG(CASE WHEN pnl > 0 THEN 100 ELSE 0 END), 0)::DECIMAL as win_rate,
    COALESCE(AVG(pnl), 0)::DECIMAL as avg_pnl,
    COALESCE(SUM(pnl), 0)::DECIMAL as total_pnl
  FROM trade_journal tj
  WHERE tj.closed_at > NOW() - (p_days || ' days')::INTERVAL
  GROUP BY tj.symbol
  HAVING COUNT(*) >= p_min_trades
  ORDER BY win_rate DESC;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_trade_stats TO service_role;
GRANT EXECUTE ON FUNCTION get_performance_by_condition TO service_role;
GRANT EXECUTE ON FUNCTION get_symbol_performance TO service_role;
