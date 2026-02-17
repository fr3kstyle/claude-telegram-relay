-- BEHEMOTH Trading System: System Events and Liquidations
-- System logging, liquidation tracking, and configuration

-- ============================================================
-- System Events (enhanced for trading)
-- ============================================================
CREATE TABLE IF NOT EXISTS system_events (
  id BIGSERIAL PRIMARY KEY,

  -- Event details
  event_type TEXT NOT NULL,
  event_category TEXT CHECK (event_category IN (
    'scanner', 'signal', 'execution', 'risk', 'ml',
    'system', 'error', 'alert', 'config', 'maintenance'
  )),
  severity TEXT CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
  message TEXT NOT NULL,

  -- Context
  symbol TEXT,
  scanner_tier TEXT,
  service_name TEXT,

  -- Related entities
  execution_id BIGINT REFERENCES trade_executions(id),
  signal_id BIGINT REFERENCES trading_signals(id),
  thread_id TEXT,

  -- Additional data
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_events_type_time
  ON system_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_category
  ON system_events (event_category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_symbol
  ON system_events (symbol, created_at DESC) WHERE symbol IS NOT NULL;

-- ============================================================
-- Liquidation Events (Binance/Bybit feeds)
-- ============================================================
CREATE TABLE IF NOT EXISTS liquidation_events (
  id BIGSERIAL PRIMARY KEY,

  -- Event details
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price NUMERIC(20, 8) NOT NULL,
  quantity NUMERIC(24, 8) NOT NULL,
  order_type TEXT,

  -- Value
  usd_value NUMERIC(24, 8) NOT NULL,

  -- Timing
  event_time TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Aggregation
  minute_bucket TIMESTAMPTZ,
  bucket_count INTEGER DEFAULT 1,
  bucket_total_usd NUMERIC(24, 8) DEFAULT 0,

  -- Impact analysis
  price_impact_1m NUMERIC(10, 6),
  price_impact_5m NUMERIC(10, 6),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_liquidation_events_symbol_time
  ON liquidation_events (symbol, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_liquidation_events_bucket
  ON liquidation_events (symbol, minute_bucket);

-- ============================================================
-- Liquidation Summary (aggregated view)
-- ============================================================
CREATE TABLE IF NOT EXISTS liquidation_summary (
  id BIGSERIAL PRIMARY KEY,

  symbol TEXT NOT NULL,
  timeframe TEXT DEFAULT '1m',
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_end TIMESTAMPTZ NOT NULL,

  -- Long liquidations
  long_count INTEGER DEFAULT 0,
  long_total_usd NUMERIC(24, 8) DEFAULT 0,
  long_avg_price NUMERIC(20, 8),
  long_max_single NUMERIC(24, 8) DEFAULT 0,

  -- Short liquidations
  short_count INTEGER DEFAULT 0,
  short_total_usd NUMERIC(24, 8) DEFAULT 0,
  short_avg_price NUMERIC(20, 8),
  short_max_single NUMERIC(24, 8) DEFAULT 0,

  -- Net
  net_usd NUMERIC(24, 8) DEFAULT 0,
  dominant_side TEXT,

  -- Price context
  price_start NUMERIC(20, 8),
  price_end NUMERIC(20, 8),
  price_high NUMERIC(20, 8),
  price_low NUMERIC(20, 8),
  price_change_percent NUMERIC(10, 4),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(symbol, timeframe, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_liquidation_summary_symbol_time
  ON liquidation_summary (symbol, bucket_start DESC);

-- ============================================================
-- Trading Configuration
-- ============================================================
CREATE TABLE IF NOT EXISTS trading_config (
  id SERIAL PRIMARY KEY,
  config_key TEXT NOT NULL UNIQUE,
  config_value JSONB NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',

  -- Validation
  schema JSONB,
  is_valid BOOLEAN DEFAULT TRUE,
  last_validated TIMESTAMPTZ,

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

-- Insert default configuration
INSERT INTO trading_config (config_key, config_value, description, category) VALUES
  -- Scanner config
  ('scanner.top10.symbols', '["BTCUSDT", "ETHUSDT"]'::jsonb, 'Top 10 symbols by volume', 'scanner'),
  ('scanner.top10.interval_seconds', '60'::jsonb, 'Top 10 scan interval', 'scanner'),
  ('scanner.top20.symbols', '["SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT"]'::jsonb, 'Top 20 symbols', 'scanner'),
  ('scanner.top20.interval_seconds', '120'::jsonb, 'Top 20 scan interval', 'scanner'),
  ('scanner.top50.interval_seconds', '600'::jsonb, 'Top 50 scan interval', 'scanner'),

  -- Signal config
  ('signal.confidence_threshold.top10', '78'::jsonb, 'Minimum confidence for top10', 'signal'),
  ('signal.confidence_threshold.top20', '80'::jsonb, 'Minimum confidence for top20', 'signal'),
  ('signal.confidence_threshold.top50', '82'::jsonb, 'Minimum confidence for top50', 'signal'),
  ('signal.expiry_seconds', '300'::jsonb, 'Signal expiry time', 'signal'),

  -- Execution config
  ('execution.min_position_usd', '2'::jsonb, 'Minimum position size', 'execution'),
  ('execution.max_position_usd', '10'::jsonb, 'Maximum position size', 'execution'),
  ('execution.default_leverage', '50'::jsonb, 'Default leverage', 'execution'),
  ('execution.max_leverage', '125'::jsonb, 'Maximum leverage', 'execution'),

  -- Risk config
  ('risk.daily_loss_limit', '15'::jsonb, 'Daily loss limit percent', 'risk'),
  ('risk.max_drawdown', '30'::jsonb, 'Maximum drawdown percent', 'risk'),
  ('risk.max_positions', '2'::jsonb, 'Maximum concurrent positions', 'risk'),
  ('risk.position_size_percent', '5'::jsonb, 'Max position size as % of account', 'risk'),

  -- Leverage tiers
  ('leverage.tiers', '[{"min_confidence": 95, "min_strength": 85, "leverage": 125}, {"min_confidence": 85, "min_strength": 70, "leverage": 100}, {"min_confidence": 75, "min_strength": 60, "leverage": 75}, {"min_confidence": 70, "min_strength": 50, "leverage": 50}]'::jsonb, 'Leverage tiers', 'execution')

ON CONFLICT (config_key) DO NOTHING;

-- ============================================================
-- Scanner State (track what's being scanned)
-- ============================================================
CREATE TABLE IF NOT EXISTS scanner_state (
  id SERIAL PRIMARY KEY,
  scanner_tier TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  last_scan_at TIMESTAMPTZ,
  last_signal_at TIMESTAMPTZ,
  scans_today INTEGER DEFAULT 0,
  signals_today INTEGER DEFAULT 0,
  errors_today INTEGER DEFAULT 0,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  current_symbols TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO scanner_state (scanner_tier) VALUES ('top10'), ('top20'), ('top50')
ON CONFLICT (scanner_tier) DO NOTHING;

-- ============================================================
-- Functions
-- ============================================================

-- Log system event
CREATE OR REPLACE FUNCTION log_system_event(
  p_event_type TEXT,
  p_message TEXT,
  p_category TEXT DEFAULT 'system',
  p_severity TEXT DEFAULT 'info',
  p_symbol TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS void AS $$
BEGIN
  INSERT INTO system_events (
    event_type,
    event_category,
    severity,
    message,
    symbol,
    metadata
  ) VALUES (
    p_event_type,
    p_category,
    p_severity,
    p_message,
    p_symbol,
    p_metadata
  );
END;
$$ LANGUAGE plpgsql;

-- Aggregate liquidations
CREATE OR REPLACE FUNCTION aggregate_liquidations(
  p_symbol TEXT,
  p_bucket_start TIMESTAMPTZ
)
RETURNS void AS $$
DECLARE
  v_bucket_end TIMESTAMPTZ := p_bucket_start + INTERVAL '1 minute';
BEGIN
  INSERT INTO liquidation_summary (
    symbol,
    bucket_start,
    bucket_end,
    long_count,
    long_total_usd,
    long_avg_price,
    long_max_single,
    short_count,
    short_total_usd,
    short_avg_price,
    short_max_single,
    net_usd,
    dominant_side
  )
  SELECT
    p_symbol,
    p_bucket_start,
    v_bucket_end,
    COUNT(*) FILTER (WHERE side = 'buy'),
    COALESCE(SUM(usd_value) FILTER (WHERE side = 'buy'), 0),
    AVG(price) FILTER (WHERE side = 'buy'),
    MAX(usd_value) FILTER (WHERE side = 'buy'),
    COUNT(*) FILTER (WHERE side = 'sell'),
    COALESCE(SUM(usd_value) FILTER (WHERE side = 'sell'), 0),
    AVG(price) FILTER (WHERE side = 'sell'),
    MAX(usd_value) FILTER (WHERE side = 'sell'),
    COALESCE(SUM(usd_value) FILTER (WHERE side = 'buy'), 0) -
      COALESCE(SUM(usd_value) FILTER (WHERE side = 'sell'), 0),
    CASE
      WHEN SUM(usd_value) FILTER (WHERE side = 'buy') >
           SUM(usd_value) FILTER (WHERE side = 'sell') THEN 'long'
      WHEN SUM(usd_value) FILTER (WHERE side = 'sell') >
           SUM(usd_value) FILTER (WHERE side = 'buy') THEN 'short'
      ELSE 'neutral'
    END
  FROM liquidation_events
  WHERE symbol = p_symbol
    AND event_time >= p_bucket_start
    AND event_time < v_bucket_end
  GROUP BY p_symbol
  ON CONFLICT (symbol, timeframe, bucket_start)
  DO UPDATE SET
    long_count = EXCLUDED.long_count,
    long_total_usd = EXCLUDED.long_total_usd,
    long_avg_price = EXCLUDED.long_avg_price,
    long_max_single = EXCLUDED.long_max_single,
    short_count = EXCLUDED.short_count,
    short_total_usd = EXCLUDED.short_total_usd,
    short_avg_price = EXCLUDED.short_avg_price,
    short_max_single = EXCLUDED.short_max_single,
    net_usd = EXCLUDED.net_usd,
    dominant_side = EXCLUDED.dominant_side;
END;
$$ LANGUAGE plpgsql;

-- Get config value
CREATE OR REPLACE FUNCTION get_trading_config(
  p_key TEXT,
  p_default JSONB DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_value JSONB;
BEGIN
  SELECT config_value INTO v_value
  FROM trading_config
  WHERE config_key = p_key AND is_valid = TRUE;

  RETURN COALESCE(v_value, p_default);
END;
$$ LANGUAGE plpgsql;

-- Update scanner state
CREATE OR REPLACE FUNCTION update_scanner_state(
  p_tier TEXT,
  p_scan BOOLEAN DEFAULT TRUE,
  p_signal BOOLEAN DEFAULT FALSE,
  p_error TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  UPDATE scanner_state
  SET
    last_scan_at = CASE WHEN p_scan THEN NOW() ELSE last_scan_at END,
    last_signal_at = CASE WHEN p_signal THEN NOW() ELSE last_signal_at END,
    scans_today = CASE WHEN p_scan THEN scans_today + 1 ELSE scans_today END,
    signals_today = CASE WHEN p_signal THEN signals_today + 1 ELSE signals_today END,
    errors_today = CASE WHEN p_error IS NOT NULL THEN errors_today + 1 ELSE errors_today END,
    last_error = p_error,
    last_error_at = CASE WHEN p_error IS NOT NULL THEN NOW() ELSE last_error_at END,
    updated_at = NOW()
  WHERE scanner_tier = p_tier;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Views
-- ============================================================

-- Liquidation activity view
CREATE OR REPLACE VIEW liquidation_activity_view AS
SELECT
  symbol,
  bucket_start,
  long_total_usd,
  short_total_usd,
  net_usd,
  dominant_side,
  ABS(net_usd) as imbalance_usd
FROM liquidation_summary
WHERE bucket_start > NOW() - INTERVAL '1 hour'
ORDER BY ABS(net_usd) DESC;

-- Scanner status view
CREATE OR REPLACE VIEW scanner_status_view AS
SELECT
  scanner_tier,
  is_active,
  last_scan_at,
  EXTRACT(EPOCH FROM (NOW() - last_scan_at)) as seconds_since_scan,
  scans_today,
  signals_today,
  errors_today,
  last_error,
  array_length(current_symbols, 1) as symbol_count
FROM scanner_state
ORDER BY scanner_tier;

COMMENT ON TABLE system_events IS 'System event log for trading operations';
COMMENT ON TABLE liquidation_events IS 'Individual liquidation events from exchanges';
COMMENT ON TABLE liquidation_summary IS 'Aggregated liquidation data by time bucket';
COMMENT ON TABLE trading_config IS 'Dynamic trading configuration';
COMMENT ON TABLE scanner_state IS 'Current state of each scanner tier';
