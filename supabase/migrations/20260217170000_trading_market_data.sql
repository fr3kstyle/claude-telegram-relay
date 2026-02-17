-- BEHEMOTH Trading System: Market Data Schema
-- OHLCV data, technical features, and market structure

-- ============================================================
-- OHLCV 1-minute candles
-- ============================================================
CREATE TABLE IF NOT EXISTS ohlcv_1m (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'bybit',
  timestamp TIMESTAMPTZ NOT NULL,
  open NUMERIC(20, 8) NOT NULL,
  high NUMERIC(20, 8) NOT NULL,
  low NUMERIC(20, 8) NOT NULL,
  close NUMERIC(20, 8) NOT NULL,
  volume NUMERIC(24, 8) NOT NULL,
  quote_volume NUMERIC(24, 8),
  trades INTEGER,
  taker_buy_volume NUMERIC(24, 8),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast symbol + time queries
CREATE INDEX IF NOT EXISTS idx_ohlcv_1m_symbol_time
  ON ohlcv_1m (symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ohlcv_1m_exchange
  ON ohlcv_1m (exchange);

-- Unique constraint to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_ohlcv_1m_unique
  ON ohlcv_1m (symbol, exchange, timestamp);

-- Partitioning hint for future (by month)
-- ALTER TABLE ohlcv_1m PARTITION BY RANGE (timestamp);

-- ============================================================
-- Technical Features (pre-calculated indicators)
-- ============================================================
CREATE TABLE IF NOT EXISTS technical_features (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1m',

  -- Trend indicators
  ema_9 NUMERIC(20, 8),
  ema_21 NUMERIC(20, 8),
  ema_50 NUMERIC(20, 8),
  ema_200 NUMERIC(20, 8),
  sma_20 NUMERIC(20, 8),

  -- Momentum indicators
  rsi_14 NUMERIC(10, 4),
  rsi_7 NUMERIC(10, 4),
  macd_line NUMERIC(20, 8),
  macd_signal NUMERIC(20, 8),
  macd_histogram NUMERIC(20, 8),
  stoch_k NUMERIC(10, 4),
  stoch_d NUMERIC(10, 4),

  -- Volatility indicators
  bb_upper NUMERIC(20, 8),
  bb_middle NUMERIC(20, 8),
  bb_lower NUMERIC(20, 8),
  bb_width NUMERIC(10, 4),
  atr_14 NUMERIC(20, 8),
  atr_percent NUMERIC(10, 4),

  -- Volume indicators
  obv NUMERIC(24, 8),
  vwap NUMERIC(20, 8),
  volume_sma_20 NUMERIC(24, 8),
  volume_ratio NUMERIC(10, 4),

  -- Support/Resistance
  pivot_point NUMERIC(20, 8),
  resistance_1 NUMERIC(20, 8),
  resistance_2 NUMERIC(20, 8),
  resistance_3 NUMERIC(20, 8),
  support_1 NUMERIC(20, 8),
  support_2 NUMERIC(20, 8),
  support_3 NUMERIC(20, 8),

  -- Pattern detection
  pattern_doji BOOLEAN DEFAULT FALSE,
  pattern_hammer BOOLEAN DEFAULT FALSE,
  pattern_engulfing INTEGER DEFAULT 0, -- -1 bearish, 0 none, 1 bullish
  pattern_three_white_soldiers BOOLEAN DEFAULT FALSE,
  pattern_three_black_crows BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_technical_features_symbol_time
  ON technical_features (symbol, timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_technical_features_unique
  ON technical_features (symbol, timeframe, timestamp);

-- ============================================================
-- Market Structure (higher timeframes)
-- ============================================================
CREATE TABLE IF NOT EXISTS market_structure (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1h',
  timestamp TIMESTAMPTZ NOT NULL,

  -- Trend analysis
  trend_direction TEXT CHECK (trend_direction IN ('bullish', 'bearish', 'sideways')),
  trend_strength NUMERIC(5, 2), -- 0-100

  -- Market structure
  higher_high BOOLEAN,
  higher_low BOOLEAN,
  lower_high BOOLEAN,
  lower_low BOOLEAN,
  breakout_level NUMERIC(20, 8),
  breakdown_level NUMERIC(20, 8),

  -- Liquidity
  liquidity_grab BOOLEAN DEFAULT FALSE,
  liquidity_level NUMERIC(20, 8),

  -- Smart money concepts
  order_block_high NUMERIC(20, 8),
  order_block_low NUMERIC(20, 8),
  fair_value_gap_high NUMERIC(20, 8),
  fair_value_gap_low NUMERIC(20, 8),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_structure_symbol_time
  ON market_structure (symbol, timestamp DESC);

-- ============================================================
-- Function to aggregate 1m to higher timeframes
-- ============================================================
CREATE OR REPLACE FUNCTION aggregate_ohlcv(
  p_symbol TEXT,
  p_from_time TIMESTAMPTZ,
  p_to_time TIMESTAMPTZ,
  p_interval_minutes INTEGER
)
RETURNS TABLE (
  timestamp TIMESTAMPTZ,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC,
  volume NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('hour', o.timestamp) +
      INTERVAL '1 minute' * (FLOOR(EXTRACT(MINUTE FROM o.timestamp) / p_interval_minutes) * p_interval_minutes) as timestamp,
    FIRST_VALUE(o.open ORDER BY o.timestamp) as open,
    MAX(o.high) as high,
    MIN(o.low) as low,
    LAST_VALUE(o.close ORDER BY o.timestamp) as close,
    SUM(o.volume) as volume
  FROM ohlcv_1m o
  WHERE o.symbol = p_symbol
    AND o.timestamp >= p_from_time
    AND o.timestamp < p_to_time
  GROUP BY
    date_trunc('hour', o.timestamp) +
      INTERVAL '1 minute' * (FLOOR(EXTRACT(MINUTE FROM o.timestamp) / p_interval_minutes) * p_interval_minutes)
  ORDER BY 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Cleanup old data (run via cron)
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_old_ohlcv()
RETURNS void AS $$
BEGIN
  -- Keep 1m data for 7 days
  DELETE FROM ohlcv_1m WHERE timestamp < NOW() - INTERVAL '7 days';

  -- Log cleanup (system_events table created in 20260217220000_trading_system.sql)
  -- Use PERFORM with exception handling for forward compatibility
  BEGIN
    INSERT INTO system_events (event_type, message, metadata)
    VALUES ('ohlcv_cleanup', 'Cleaned up old OHLCV data', '{"retention_days": 7}'::jsonb);
  EXCEPTION WHEN undefined_table THEN
    -- Table not yet created, skip logging
    NULL;
  END;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE ohlcv_1m IS '1-minute OHLCV candle data for all trading pairs';
COMMENT ON TABLE technical_features IS 'Pre-calculated technical indicators for signal generation';
COMMENT ON TABLE market_structure IS 'Higher timeframe market structure analysis';
