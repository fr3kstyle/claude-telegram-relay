-- Paper Trading Tables
-- For simulating trades without real execution

-- Paper positions (open trades)
CREATE TABLE IF NOT EXISTS paper_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DECIMAL(20, 8) NOT NULL,
  size DECIMAL(20, 8) NOT NULL,
  leverage INTEGER DEFAULT 10,
  stop_loss DECIMAL(20, 8),
  take_profit DECIMAL(20, 8),
  signal_id TEXT,
  status TEXT DEFAULT 'open',
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Paper trades history (completed trades)
CREATE TABLE IF NOT EXISTS paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DECIMAL(20, 8) NOT NULL,
  exit_price DECIMAL(20, 8) NOT NULL,
  size DECIMAL(20, 8) NOT NULL,
  leverage INTEGER DEFAULT 10,
  pnl DECIMAL(20, 8) NOT NULL,
  pnl_percent DECIMAL(10, 4) NOT NULL,
  entry_reason TEXT,
  exit_reason TEXT,
  signal_confidence INTEGER,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_paper_positions_symbol ON paper_positions(symbol);
CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol);
CREATE INDEX IF NOT EXISTS idx_paper_trades_closed_at ON paper_trades(closed_at DESC);

-- Enable RLS
ALTER TABLE paper_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Service role can manage paper positions" ON paper_positions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role can manage paper trades" ON paper_trades
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- View for paper trading stats
CREATE OR REPLACE VIEW paper_trading_stats AS
SELECT
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE pnl > 0) as wins,
  COUNT(*) FILTER (WHERE pnl < 0) as losses,
  ROUND(COUNT(*) FILTER (WHERE pnl > 0)::DECIMAL / NULLIF(COUNT(*), 0) * 100, 1) as win_rate,
  ROUND(SUM(pnl)::DECIMAL, 2) as total_pnl,
  ROUND(AVG(pnl)::DECIMAL, 2) as avg_pnl,
  ROUND(AVG(pnl) FILTER (WHERE pnl > 0)::DECIMAL, 2) as avg_win,
  ROUND(AVG(pnl) FILTER (WHERE pnl < 0)::DECIMAL, 2) as avg_loss
FROM paper_trades;
