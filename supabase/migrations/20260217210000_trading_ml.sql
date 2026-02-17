-- BEHEMOTH Trading System: ML and Strategy Schema
-- Model tracking, predictions, and strategy performance

-- ============================================================
-- ML Models Registry
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_models (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  model_type TEXT NOT NULL CHECK (model_type IN ('lstm', 'transformer', 'xgboost', 'ensemble', 'other')),
  description TEXT,

  -- Model configuration
  version TEXT NOT NULL DEFAULT '1.0.0',
  features TEXT[] NOT NULL DEFAULT '{}',
  lookback_period INTEGER DEFAULT 60,
  prediction_horizon INTEGER DEFAULT 5, -- minutes

  -- Training info
  training_start_date TIMESTAMPTZ,
  training_end_date TIMESTAMPTZ,
  training_samples INTEGER,
  last_trained_at TIMESTAMPTZ,
  training_duration_seconds INTEGER,

  -- Performance metrics
  accuracy NUMERIC(5, 2),
  precision_score NUMERIC(5, 2),
  recall NUMERIC(5, 2),
  f1_score NUMERIC(5, 2),
  auc_roc NUMERIC(5, 2),
  sharpe_contribution NUMERIC(10, 4),

  -- Status
  is_active BOOLEAN DEFAULT FALSE,
  is_production BOOLEAN DEFAULT FALSE,
  deployment_date TIMESTAMPTZ,

  -- File paths
  model_path TEXT,
  scaler_path TEXT,

  -- Metadata
  hyperparameters JSONB DEFAULT '{}'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ML Predictions Log
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_predictions (
  id BIGSERIAL PRIMARY KEY,
  model_id INTEGER REFERENCES ml_models(id),

  -- Prediction details
  symbol TEXT NOT NULL,
  prediction_time TIMESTAMPTZ NOT NULL,
  target_time TIMESTAMPTZ NOT NULL,

  -- Prediction values
  predicted_direction TEXT CHECK (predicted_direction IN ('up', 'down', 'neutral')),
  predicted_return NUMERIC(10, 6),
  predicted_price NUMERIC(20, 8),
  confidence NUMERIC(5, 2),

  -- Probability distribution
  prob_up NUMERIC(5, 2),
  prob_down NUMERIC(5, 2),
  prob_neutral NUMERIC(5, 2),

  -- Actual outcome (filled later)
  actual_direction TEXT,
  actual_return NUMERIC(10, 6),
  actual_price NUMERIC(20, 8),

  -- Performance tracking
  is_correct BOOLEAN,
  error NUMERIC(10, 6),

  -- Features used (snapshot)
  features_snapshot JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_predictions_symbol_time
  ON ml_predictions (symbol, prediction_time DESC);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_model
  ON ml_predictions (model_id, prediction_time DESC);

-- ============================================================
-- Strategy Performance
-- ============================================================
CREATE TABLE IF NOT EXISTS strategy_performance (
  id BIGSERIAL PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT DEFAULT '1.0.0',

  -- Time period
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  period_type TEXT CHECK (period_type IN ('hourly', 'daily', 'weekly', 'monthly', 'all_time')),

  -- Trade statistics
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  breakeven_trades INTEGER DEFAULT 0,
  win_rate NUMERIC(5, 2) DEFAULT 0,

  -- PnL metrics
  total_pnl NUMERIC(24, 8) DEFAULT 0,
  total_pnl_percent NUMERIC(10, 4) DEFAULT 0,
  avg_win NUMERIC(20, 8) DEFAULT 0,
  avg_loss NUMERIC(20, 8) DEFAULT 0,
  largest_win NUMERIC(20, 8) DEFAULT 0,
  largest_loss NUMERIC(20, 8) DEFAULT 0,
  profit_factor NUMERIC(10, 4) DEFAULT 0,

  -- Risk metrics
  max_drawdown NUMERIC(10, 4) DEFAULT 0,
  avg_mae NUMERIC(10, 4) DEFAULT 0,
  avg_mfe NUMERIC(10, 4) DEFAULT 0,
  recovery_factor NUMERIC(10, 4) DEFAULT 0,

  -- Performance ratios
  sharpe_ratio NUMERIC(10, 4),
  sortino_ratio NUMERIC(10, 4),
  calmar_ratio NUMERIC(10, 4),
  expectancy NUMERIC(10, 4) DEFAULT 0,

  -- Signal quality
  avg_confidence NUMERIC(5, 2) DEFAULT 0,
  avg_signal_strength NUMERIC(5, 2) DEFAULT 0,
  layer_contribution JSONB DEFAULT '{}'::jsonb,

  -- Time metrics
  avg_trade_duration_seconds INTEGER DEFAULT 0,
  trades_per_hour NUMERIC(10, 2) DEFAULT 0,
  best_hour INTEGER,
  worst_hour INTEGER,
  best_day TEXT,
  worst_day TEXT,

  -- Scanner tier performance
  top10_trades INTEGER DEFAULT 0,
  top10_win_rate NUMERIC(5, 2) DEFAULT 0,
  top20_trades INTEGER DEFAULT 0,
  top20_win_rate NUMERIC(5, 2) DEFAULT 0,
  top50_trades INTEGER DEFAULT 0,
  top50_win_rate NUMERIC(5, 2) DEFAULT 0,

  -- Status
  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(strategy_name, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_strategy_performance_name
  ON strategy_performance (strategy_name, period_start DESC);

-- ============================================================
-- Pattern Mining Results
-- ============================================================
CREATE TABLE IF NOT EXISTS mined_patterns (
  id BIGSERIAL PRIMARY KEY,

  -- Pattern identification
  pattern_name TEXT NOT NULL,
  pattern_type TEXT CHECK (pattern_type IN (
    'price_action', 'indicator_signal', 'time_based',
    'correlation', 'volume_profile', 'market_structure'
  )),

  -- Pattern definition
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeframe TEXT DEFAULT '1m',

  -- Performance metrics
  occurrence_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  success_rate NUMERIC(5, 2) DEFAULT 0,

  -- Expected outcomes
  avg_return NUMERIC(10, 4) DEFAULT 0,
  avg_return_up NUMERIC(10, 4) DEFAULT 0,
  avg_return_down NUMERIC(10, 4) DEFAULT 0,
  avg_time_to_target_seconds INTEGER,

  -- Statistical significance
  p_value NUMERIC(10, 6),
  confidence_interval_low NUMERIC(10, 4),
  confidence_interval_high NUMERIC(10, 4),
  is_significant BOOLEAN DEFAULT FALSE,

  -- Market context
  applicable_conditions TEXT[] DEFAULT '{}',
  avoid_conditions TEXT[] DEFAULT '{}',

  -- Status
  is_verified BOOLEAN DEFAULT FALSE,
  last_verified_at TIMESTAMPTZ,
  verification_trades INTEGER DEFAULT 0,

  -- Mining metadata
  mined_at TIMESTAMPTZ DEFAULT NOW(),
  mining_run_id TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mined_patterns_type
  ON mined_patterns (pattern_type, success_rate DESC);
CREATE INDEX IF NOT EXISTS idx_mined_patterns_significant
  ON mined_patterns (is_significant, success_rate DESC) WHERE is_significant = TRUE;

-- ============================================================
-- Functions
-- ============================================================

-- Update ML prediction with actual outcome
CREATE OR REPLACE FUNCTION update_prediction_outcome(
  p_prediction_id BIGINT,
  p_actual_price NUMERIC,
  p_actual_return NUMERIC
)
RETURNS void AS $$
DECLARE
  v_prediction RECORD;
  v_error NUMERIC;
BEGIN
  SELECT * INTO v_prediction
  FROM ml_predictions WHERE id = p_prediction_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_error := ABS(p_actual_return - v_prediction.predicted_return);

  UPDATE ml_predictions
  SET
    actual_price = p_actual_price,
    actual_return = p_actual_return,
    actual_direction = CASE
      WHEN p_actual_return > 0.001 THEN 'up'
      WHEN p_actual_return < -0.001 THEN 'down'
      ELSE 'neutral'
    END,
    is_correct = (v_prediction.predicted_direction =
      CASE
        WHEN p_actual_return > 0.001 THEN 'up'
        WHEN p_actual_return < -0.001 THEN 'down'
        ELSE 'neutral'
      END),
    error = v_error
  WHERE id = p_prediction_id;

  -- Update model accuracy
  UPDATE ml_models m
  SET
    accuracy = (
      SELECT COUNT(*) FILTER (WHERE is_correct) * 100.0 / COUNT(*)
      FROM ml_predictions
      WHERE model_id = m.id AND is_correct IS NOT NULL
    ),
    updated_at = NOW()
  WHERE id = v_prediction.model_id;
END;
$$ LANGUAGE plpgsql;

-- Calculate strategy performance for period
CREATE OR REPLACE FUNCTION calculate_strategy_performance(
  p_strategy_name TEXT,
  p_period_start TIMESTAMPTZ,
  p_period_end TIMESTAMPTZ,
  p_period_type TEXT DEFAULT 'daily'
)
RETURNS void AS $$
BEGIN
  INSERT INTO strategy_performance (
    strategy_name,
    period_start,
    period_end,
    period_type,
    total_trades,
    winning_trades,
    losing_trades,
    win_rate,
    total_pnl,
    avg_win,
    avg_loss,
    profit_factor,
    max_drawdown,
    avg_mae,
    avg_mfe,
    avg_confidence,
    avg_trade_duration_seconds
  )
  SELECT
    p_strategy_name,
    p_period_start,
    p_period_end,
    p_period_type,
    COUNT(*),
    COUNT(*) FILTER (WHERE realized_pnl > 0),
    COUNT(*) FILTER (WHERE realized_pnl < 0),
    COUNT(*) FILTER (WHERE realized_pnl > 0) * 100.0 / NULLIF(COUNT(*), 0),
    SUM(realized_pnl),
    AVG(realized_pnl) FILTER (WHERE realized_pnl > 0),
    AVG(realized_pnl) FILTER (WHERE realized_pnl < 0),
    ABS(SUM(realized_pnl) FILTER (WHERE realized_pnl > 0)) /
      NULLIF(ABS(SUM(realized_pnl) FILTER (WHERE realized_pnl < 0)), 0),
    MAX(mae),
    AVG(mae),
    AVG(mfe),
    (SELECT AVG(confidence) FROM trading_signals s
     WHERE s.execution_id = te.id),
    AVG(duration_seconds)
  FROM trade_executions te
  WHERE te.closed_at >= p_period_start
    AND te.closed_at < p_period_end
    AND te.status = 'closed'
  ON CONFLICT (strategy_name, period_type, period_start) DO UPDATE SET
    total_trades = EXCLUDED.total_trades,
    winning_trades = EXCLUDED.winning_trades,
    losing_trades = EXCLUDED.losing_trades,
    win_rate = EXCLUDED.win_rate,
    total_pnl = EXCLUDED.total_pnl,
    avg_win = EXCLUDED.avg_win,
    avg_loss = EXCLUDED.avg_loss,
    profit_factor = EXCLUDED.profit_factor,
    max_drawdown = EXCLUDED.max_drawdown,
    avg_mae = EXCLUDED.avg_mae,
    avg_mfe = EXCLUDED.avg_mfe,
    avg_confidence = EXCLUDED.avg_confidence,
    avg_trade_duration_seconds = EXCLUDED.avg_trade_duration_seconds,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE ml_models IS 'ML model registry and performance tracking';
COMMENT ON TABLE ml_predictions IS 'Log of all ML predictions with outcomes';
COMMENT ON TABLE strategy_performance IS 'Strategy performance metrics by period';
COMMENT ON TABLE mined_patterns IS 'Discovered trading patterns from data mining';
