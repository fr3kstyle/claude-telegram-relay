-- BEHEMOTH Trading System: Risk Management Schema
-- Risk metrics, account history, and alerts

-- ============================================================
-- Risk Metrics (real-time tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS risk_metrics (
  id BIGSERIAL PRIMARY KEY,

  -- Daily metrics
  trading_date DATE NOT NULL DEFAULT CURRENT_DATE,
  daily_pnl NUMERIC(20, 8) DEFAULT 0,
  daily_pnl_percent NUMERIC(10, 4) DEFAULT 0,
  daily_trades INTEGER DEFAULT 0,
  daily_wins INTEGER DEFAULT 0,
  daily_losses INTEGER DEFAULT 0,
  daily_win_rate NUMERIC(5, 2) DEFAULT 0,

  -- Drawdown tracking
  current_drawdown NUMERIC(10, 4) DEFAULT 0,
  max_drawdown NUMERIC(10, 4) DEFAULT 0,
  drawdown_start_date TIMESTAMPTZ,

  -- Position risk
  open_positions INTEGER DEFAULT 0,
  total_exposure_usd NUMERIC(24, 8) DEFAULT 0,
  max_single_exposure_usd NUMERIC(24, 8) DEFAULT 0,
  current_leverage_avg NUMERIC(10, 2) DEFAULT 0,
  max_leverage_used INTEGER DEFAULT 0,

  -- Risk limits
  daily_loss_limit NUMERIC(10, 4) DEFAULT 15.00, -- 15%
  max_drawdown_limit NUMERIC(10, 4) DEFAULT 30.00, -- 30%
  max_positions INTEGER DEFAULT 2,
  max_position_size_percent NUMERIC(5, 2) DEFAULT 5.00, -- 5%

  -- Emergency controls
  emergency_stop_triggered BOOLEAN DEFAULT FALSE,
  emergency_stop_at TIMESTAMPTZ,
  trading_enabled BOOLEAN DEFAULT TRUE,
  trading_paused_until TIMESTAMPTZ,

  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(trading_date)
);

CREATE INDEX IF NOT EXISTS idx_risk_metrics_date
  ON risk_metrics (trading_date DESC);

-- Insert initial risk metrics
INSERT INTO risk_metrics (trading_date) VALUES (CURRENT_DATE)
ON CONFLICT (trading_date) DO NOTHING;

-- ============================================================
-- Account History (snapshots)
-- ============================================================
CREATE TABLE IF NOT EXISTS account_history (
  id BIGSERIAL PRIMARY KEY,

  -- Balance tracking
  total_balance_usd NUMERIC(24, 8) NOT NULL,
  available_balance_usd NUMERIC(24, 8) NOT NULL,
  used_margin_usd NUMERIC(24, 8) DEFAULT 0,
  unrealized_pnl_usd NUMERIC(24, 8) DEFAULT 0,

  -- Equity curve
  equity_usd NUMERIC(24, 8) NOT NULL,
  equity_high NUMERIC(24, 8),
  equity_low NUMERIC(24, 8),

  -- Performance metrics
  cumulative_pnl NUMERIC(24, 8) DEFAULT 0,
  cumulative_pnl_percent NUMERIC(10, 4) DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  win_rate NUMERIC(5, 2) DEFAULT 0,

  -- Risk metrics
  sharpe_ratio NUMERIC(10, 4),
  sortino_ratio NUMERIC(10, 4),
  calmar_ratio NUMERIC(10, 4),
  max_drawdown NUMERIC(10, 4),
  avg_trade_duration_seconds INTEGER,

  -- Exchange info
  exchange TEXT DEFAULT 'bybit',

  -- Timestamp
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_history_time
  ON account_history (snapshot_at DESC);

-- ============================================================
-- Alerts
-- ============================================================
CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,

  -- Alert details
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'trade_opened', 'trade_closed', 'trade_stop_loss', 'trade_take_profit',
    'drawdown_warning', 'drawdown_critical', 'daily_loss_limit',
    'emergency_stop', 'system_error', 'liquidation_warning',
    'signal_generated', 'signal_expired', 'risk_limit'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical', 'emergency')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,

  -- Related entities
  symbol TEXT,
  execution_id BIGINT REFERENCES trade_executions(id),
  signal_id BIGINT REFERENCES trading_signals(id),

  -- Voice alert settings
  voice_alert BOOLEAN DEFAULT FALSE,
  voice_message TEXT,

  -- Status
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,

  -- Telegram delivery
  telegram_sent BOOLEAN DEFAULT FALSE,
  telegram_message_id BIGINT,
  telegram_sent_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_type_time
  ON alerts (alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged
  ON alerts (created_at DESC) WHERE acknowledged = FALSE;

-- ============================================================
-- Enable Realtime for alerts
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE alerts;

-- ============================================================
-- Functions
-- ============================================================

-- Check if trading is allowed
CREATE OR REPLACE FUNCTION check_trading_allowed()
RETURNS TABLE (
  allowed BOOLEAN,
  reason TEXT
) AS $$
DECLARE
  v_metrics RECORD;
BEGIN
  SELECT * INTO v_metrics
  FROM risk_metrics
  WHERE trading_date = CURRENT_DATE;

  IF NOT FOUND THEN
    INSERT INTO risk_metrics (trading_date) VALUES (CURRENT_DATE);
    RETURN QUERY SELECT TRUE, 'OK'::TEXT;
    RETURN;
  END IF;

  -- Check emergency stop
  IF v_metrics.emergency_stop_triggered THEN
    IF v_metrics.trading_paused_until IS NULL OR v_metrics.trading_paused_until > NOW() THEN
      RETURN QUERY SELECT FALSE, 'Emergency stop active'::TEXT;
      RETURN;
    END IF;
  END IF;

  -- Check trading enabled
  IF NOT v_metrics.trading_enabled THEN
    RETURN QUERY SELECT FALSE, 'Trading disabled'::TEXT;
    RETURN;
  END IF;

  -- Check daily loss limit
  IF v_metrics.daily_pnl_percent <= -v_metrics.daily_loss_limit THEN
    RETURN QUERY SELECT FALSE, 'Daily loss limit reached'::TEXT;
    RETURN;
  END IF;

  -- Check max drawdown
  IF v_metrics.current_drawdown >= v_metrics.max_drawdown_limit THEN
    RETURN QUERY SELECT FALSE, 'Max drawdown reached'::TEXT;
    RETURN;
  END IF;

  -- Check max positions
  IF v_metrics.open_positions >= v_metrics.max_positions THEN
    RETURN QUERY SELECT FALSE, 'Max positions reached'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'OK'::TEXT;
END;
$$ LANGUAGE plpgsql;

-- Update risk metrics after trade
CREATE OR REPLACE FUNCTION update_risk_after_trade(
  p_pnl NUMERIC,
  p_is_win BOOLEAN
)
RETURNS void AS $$
BEGIN
  INSERT INTO risk_metrics (trading_date, daily_pnl, daily_trades, daily_wins, daily_losses)
  VALUES (CURRENT_DATE, p_pnl, 1, CASE WHEN p_is_win THEN 1 ELSE 0 END, CASE WHEN p_is_win THEN 0 ELSE 1 END)
  ON CONFLICT (trading_date) DO UPDATE SET
    daily_pnl = risk_metrics.daily_pnl + p_pnl,
    daily_trades = risk_metrics.daily_trades + 1,
    daily_wins = risk_metrics.daily_wins + CASE WHEN p_is_win THEN 1 ELSE 0 END,
    daily_losses = risk_metrics.daily_losses + CASE WHEN p_is_win THEN 0 ELSE 1 END,
    daily_win_rate = (risk_metrics.daily_wins + CASE WHEN p_is_win THEN 1 ELSE 0 END)::NUMERIC /
                     NULLIF(risk_metrics.daily_trades + 1, 0) * 100,
    updated_at = NOW();

  -- Check daily loss limit
  IF (SELECT daily_pnl FROM risk_metrics WHERE trading_date = CURRENT_DATE) < 0 THEN
    INSERT INTO alerts (alert_type, severity, title, message, voice_alert)
    SELECT
      'daily_loss_limit',
      CASE WHEN daily_pnl_percent <= -15 THEN 'critical' ELSE 'warning' END,
      'Daily Loss Warning',
      'Daily loss at ' || daily_pnl_percent || '%',
      TRUE
    FROM risk_metrics
    WHERE trading_date = CURRENT_DATE AND ABS(daily_pnl_percent) >= 10;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger emergency stop
CREATE OR REPLACE FUNCTION trigger_emergency_stop(
  p_reason TEXT DEFAULT 'Manual trigger'
)
RETURNS void AS $$
BEGIN
  -- Update risk metrics
  UPDATE risk_metrics
  SET
    emergency_stop_triggered = TRUE,
    emergency_stop_at = NOW(),
    trading_enabled = FALSE,
    trading_paused_until = NOW() + INTERVAL '24 hours',
    updated_at = NOW()
  WHERE trading_date = CURRENT_DATE;

  -- Create alert
  INSERT INTO alerts (alert_type, severity, title, message, voice_alert, voice_message)
  VALUES (
    'emergency_stop',
    'emergency',
    'EMERGENCY STOP ACTIVATED',
    p_reason,
    TRUE,
    'Emergency stop activated. All trading halted for 24 hours.'
  );
END;
$$ LANGUAGE plpgsql;

-- Clear emergency stop
CREATE OR REPLACE FUNCTION clear_emergency_stop()
RETURNS void AS $$
BEGIN
  UPDATE risk_metrics
  SET
    emergency_stop_triggered = FALSE,
    trading_enabled = TRUE,
    trading_paused_until = NULL,
    updated_at = NOW()
  WHERE trading_date = CURRENT_DATE;

  INSERT INTO alerts (alert_type, severity, title, message)
  VALUES ('emergency_stop', 'info', 'Trading Resumed', 'Emergency stop cleared. Trading enabled.');
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- View: Risk Dashboard
-- ============================================================
CREATE OR REPLACE VIEW risk_dashboard_view AS
SELECT
  rm.trading_date,
  rm.daily_pnl,
  rm.daily_pnl_percent,
  rm.daily_trades,
  rm.daily_win_rate,
  rm.current_drawdown,
  rm.open_positions,
  rm.total_exposure_usd,
  rm.emergency_stop_triggered,
  rm.trading_enabled,
  ah.total_balance_usd,
  ah.equity_usd,
  ah.cumulative_pnl,
  ah.win_rate as overall_win_rate
FROM risk_metrics rm
LEFT JOIN LATERAL (
  SELECT * FROM account_history ORDER BY snapshot_at DESC LIMIT 1
) ah ON TRUE
WHERE rm.trading_date = CURRENT_DATE;

COMMENT ON TABLE risk_metrics IS 'Real-time risk metrics and limits';
COMMENT ON TABLE account_history IS 'Account balance and equity snapshots';
COMMENT ON TABLE alerts IS 'Trading alerts with Telegram and voice support';
