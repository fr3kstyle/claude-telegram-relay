-- BEHEMOTH Trading System: Signal Schema
-- 6-layer signal generation and scoring

-- ============================================================
-- Trading Signals
-- ============================================================
CREATE TABLE IF NOT EXISTS trading_signals (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('long', 'short')),
  confidence NUMERIC(5, 2) NOT NULL, -- 0-100
  signal_strength NUMERIC(5, 2) NOT NULL, -- 0-100

  -- Price levels
  entry_price NUMERIC(20, 8) NOT NULL,
  stop_loss NUMERIC(20, 8),
  take_profit_1 NUMERIC(20, 8),
  take_profit_2 NUMERIC(20, 8),
  take_profit_3 NUMERIC(20, 8),

  -- Risk/Reward
  risk_reward_ratio NUMERIC(5, 2),

  -- 6-Layer Scores (0-100 each)
  layer_technical NUMERIC(5, 2) DEFAULT 0,
  layer_orderflow NUMERIC(5, 2) DEFAULT 0,
  layer_liquidation NUMERIC(5, 2) DEFAULT 0,
  layer_sentiment NUMERIC(5, 2) DEFAULT 0,
  layer_ai_ml NUMERIC(5, 2) DEFAULT 0,
  layer_cosmic NUMERIC(5, 2) DEFAULT 0,

  -- Layer weights used (configurable)
  weight_technical NUMERIC(4, 3) DEFAULT 0.35,
  weight_orderflow NUMERIC(4, 3) DEFAULT 0.20,
  weight_liquidation NUMERIC(4, 3) DEFAULT 0.15,
  weight_sentiment NUMERIC(4, 3) DEFAULT 0.10,
  weight_ai_ml NUMERIC(4, 3) DEFAULT 0.15,
  weight_cosmic NUMERIC(4, 3) DEFAULT 0.05,

  -- Reasoning
  reasoning TEXT,
  technical_reason TEXT,
  orderflow_reason TEXT,
  liquidation_reason TEXT,
  sentiment_reason TEXT,
  ai_ml_reason TEXT,
  cosmic_reason TEXT,

  -- Source tracking
  scanner_tier TEXT CHECK (scanner_tier IN ('top10', 'top20', 'top50')),
  scanner_interval_seconds INTEGER,

  -- Execution status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
  executed_at TIMESTAMPTZ,
  execution_id BIGINT, -- FK to trade_executions

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '5 minutes'),

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_trading_signals_symbol_time
  ON trading_signals (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trading_signals_status
  ON trading_signals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trading_signals_confidence
  ON trading_signals (confidence DESC) WHERE status = 'pending';

-- ============================================================
-- Signal Weights Configuration
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_weights (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,

  -- Layer weights (must sum to 1.0)
  weight_technical NUMERIC(4, 3) DEFAULT 0.35,
  weight_orderflow NUMERIC(4, 3) DEFAULT 0.20,
  weight_liquidation NUMERIC(4, 3) DEFAULT 0.15,
  weight_sentiment NUMERIC(4, 3) DEFAULT 0.10,
  weight_ai_ml NUMERIC(4, 3) DEFAULT 0.15,
  weight_cosmic NUMERIC(4, 3) DEFAULT 0.05,

  -- Confidence thresholds by scanner tier
  threshold_top10 NUMERIC(5, 2) DEFAULT 78.00,
  threshold_top20 NUMERIC(5, 2) DEFAULT 80.00,
  threshold_top50 NUMERIC(5, 2) DEFAULT 82.00,

  -- Signal strength thresholds
  min_signal_strength NUMERIC(5, 2) DEFAULT 60.00,

  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default weight configuration
INSERT INTO signal_weights (name, description) VALUES
  ('default', 'Default 6-layer signal weights'),
  ('aggressive', 'Higher technical weight for trending markets'),
  ('conservative', 'Higher AI/ML weight for ranging markets')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Signal Performance Tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_performance (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT NOT NULL REFERENCES trading_signals(id),

  -- Outcome tracking
  outcome TEXT CHECK (outcome IN ('win', 'loss', 'breakeven', 'expired')),
  outcome_price NUMERIC(20, 8),
  pnl_percent NUMERIC(10, 4),
  pnl_usd NUMERIC(20, 8),
  mfe NUMERIC(10, 4), -- Maximum Favorable Excursion
  mae NUMERIC(10, 4), -- Maximum Adverse Excursion

  -- Time tracking
  time_to_entry INTEGER, -- seconds
  time_to_exit INTEGER, -- seconds
  duration_minutes INTEGER,

  -- Which layer contributed most
  top_layer TEXT,
  bottom_layer TEXT,

  -- Market conditions at exit
  exit_volatility NUMERIC(10, 4),
  exit_trend TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_performance_signal
  ON signal_performance (signal_id);
CREATE INDEX IF NOT EXISTS idx_signal_performance_outcome
  ON signal_performance (outcome, created_at DESC);

-- ============================================================
-- Functions for signal scoring
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_signal_score(
  p_technical NUMERIC,
  p_orderflow NUMERIC,
  p_liquidation NUMERIC,
  p_sentiment NUMERIC,
  p_ai_ml NUMERIC,
  p_cosmic NUMERIC,
  p_weight_profile TEXT DEFAULT 'default'
)
RETURNS NUMERIC AS $$
DECLARE
  w_tech NUMERIC;
  w_of NUMERIC;
  w_liq NUMERIC;
  w_sent NUMERIC;
  w_ai NUMERIC;
  w_cosmic NUMERIC;
  score NUMERIC;
BEGIN
  -- Get weights from profile
  SELECT weight_technical, weight_orderflow, weight_liquidation,
         weight_sentiment, weight_ai_ml, weight_cosmic
  INTO w_tech, w_of, w_liq, w_sent, w_ai, w_cosmic
  FROM signal_weights
  WHERE name = p_weight_profile AND is_active = TRUE
  LIMIT 1;

  -- Fallback to defaults if no profile found
  IF w_tech IS NULL THEN
    w_tech := 0.35; w_of := 0.20; w_liq := 0.15;
    w_sent := 0.10; w_ai := 0.15; w_cosmic := 0.05;
  END IF;

  -- Calculate weighted score
  score := (p_technical * w_tech) +
           (p_orderflow * w_of) +
           (p_liquidation * w_liq) +
           (p_sentiment * w_sent) +
           (p_ai_ml * w_ai) +
           (p_cosmic * w_cosmic);

  RETURN ROUND(score, 2);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- View: Active Signals with Details
-- ============================================================
CREATE OR REPLACE VIEW active_signals_view AS
SELECT
  s.id,
  s.symbol,
  s.signal_type,
  s.confidence,
  s.signal_strength,
  s.entry_price,
  s.stop_loss,
  s.take_profit_1,
  s.scanner_tier,
  s.created_at,
  s.expires_at,
  EXTRACT(EPOCH FROM (NOW() - s.created_at)) as age_seconds,
  EXTRACT(EPOCH FROM (s.expires_at - NOW())) as ttl_seconds
FROM trading_signals s
WHERE s.status = 'pending'
  AND s.expires_at > NOW()
ORDER BY s.confidence DESC, s.created_at DESC;

COMMENT ON TABLE trading_signals IS '6-layer trading signals with confidence scoring';
COMMENT ON TABLE signal_weights IS 'Configurable layer weight profiles';
COMMENT ON TABLE signal_performance IS 'Track signal outcome for learning';
