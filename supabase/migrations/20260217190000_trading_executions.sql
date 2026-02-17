-- BEHEMOTH Trading System: Trade Executions
-- Order management, positions, and trade journal

-- ============================================================
-- Trade Executions
-- ============================================================
CREATE TABLE IF NOT EXISTS trade_executions (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT REFERENCES trading_signals(id),

  -- Order details
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  position_side TEXT NOT NULL CHECK (position_side IN ('long', 'short')),
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit', 'stop_market', 'stop_limit')),

  -- Size and leverage
  position_size_usd NUMERIC(20, 8) NOT NULL,
  position_size_coin NUMERIC(24, 8),
  leverage INTEGER NOT NULL DEFAULT 1,
  margin_used NUMERIC(20, 8),
  notional_value NUMERIC(24, 8),

  -- Prices
  entry_price NUMERIC(20, 8) NOT NULL,
  exit_price NUMERIC(20, 8),
  stop_loss_price NUMERIC(20, 8),
  take_profit_price NUMERIC(20, 8),

  -- Exchange order info
  exchange TEXT NOT NULL DEFAULT 'bybit',
  exchange_order_id TEXT,
  exchange_position_id TEXT,
  client_order_id TEXT,

  -- PnL
  realized_pnl NUMERIC(20, 8) DEFAULT 0,
  realized_pnl_percent NUMERIC(10, 4) DEFAULT 0,
  unrealized_pnl NUMERIC(20, 8) DEFAULT 0,
  funding_fees NUMERIC(20, 8) DEFAULT 0,
  trading_fees NUMERIC(20, 8) DEFAULT 0,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'open', 'closing', 'closed', 'cancelled', 'liquidated')),

  -- Close reason
  close_reason TEXT CHECK (close_reason IN (
    'take_profit', 'stop_loss', 'trailing_stop', 'manual', 'emergency',
    'liquidation', 'signal_reversal', 'time_exit', 'risk_limit'
  )),

  -- Risk tracking
  mfe NUMERIC(10, 4), -- Maximum Favorable Excursion
  mae NUMERIC(10, 4), -- Maximum Adverse Excursion
  mfe_price NUMERIC(20, 8),
  mae_price NUMERIC(20, 8),

  -- Timing
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  duration_seconds INTEGER,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_trade_executions_symbol
  ON trade_executions (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_executions_status
  ON trade_executions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_executions_open
  ON trade_executions (symbol, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_trade_executions_exchange_order
  ON trade_executions (exchange, exchange_order_id);

-- ============================================================
-- Trade Journal (for learning)
-- ============================================================
CREATE TABLE IF NOT EXISTS trade_journal (
  id BIGSERIAL PRIMARY KEY,
  execution_id BIGINT NOT NULL REFERENCES trade_executions(id),

  -- Trade classification
  trade_type TEXT CHECK (trade_type IN ('scalp', 'day_trade', 'swing', 'position')),
  market_condition TEXT CHECK (market_condition IN ('trending_up', 'trending_down', 'ranging', 'volatile', 'calm')),
  session TEXT CHECK (session IN ('asian', 'london', 'new_york', 'overlap')),

  -- Setup quality
  setup_quality INTEGER CHECK (setup_quality BETWEEN 1 AND 5),
  entry_quality INTEGER CHECK (entry_quality BETWEEN 1 AND 5),
  exit_quality INTEGER CHECK (exit_quality BETWEEN 1 AND 5),

  -- Emotions/psychology
  fomo_score INTEGER CHECK (fomo_score BETWEEN 1 AND 5),
  revenge_trading BOOLEAN DEFAULT FALSE,
  followed_plan BOOLEAN DEFAULT TRUE,

  -- Lessons learned
  what_worked TEXT,
  what_didnt_work TEXT,
  lesson_learned TEXT,
  improvement_action TEXT,

  -- Pattern tags
  pattern_tags TEXT[] DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_journal_execution
  ON trade_journal (execution_id);

-- ============================================================
-- Order History (for debugging and analysis)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_history (
  id BIGSERIAL PRIMARY KEY,
  execution_id BIGINT REFERENCES trade_executions(id),

  -- Order details
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price NUMERIC(20, 8),
  quantity NUMERIC(24, 8),
  stop_price NUMERIC(20, 8),

  -- Exchange info
  exchange TEXT NOT NULL DEFAULT 'bybit',
  exchange_order_id TEXT,
  client_order_id TEXT,

  -- Status
  status TEXT NOT NULL,
  reject_reason TEXT,

  -- Fill info
  filled_quantity NUMERIC(24, 8),
  average_fill_price NUMERIC(20, 8),
  fee NUMERIC(20, 8),
  fee_currency TEXT,

  -- Timing
  submitted_at TIMESTAMPTZ,
  filled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_history_execution
  ON order_history (execution_id);
CREATE INDEX IF NOT EXISTS idx_order_history_exchange_order
  ON order_history (exchange, exchange_order_id);

-- ============================================================
-- Functions
-- ============================================================

-- Update trade execution PnL
CREATE OR REPLACE FUNCTION update_execution_pnl(
  p_execution_id BIGINT,
  p_current_price NUMERIC
)
RETURNS NUMERIC AS $$
DECLARE
  v_execution RECORD;
  v_unrealized_pnl NUMERIC;
BEGIN
  SELECT * INTO v_execution
  FROM trade_executions WHERE id = p_execution_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Calculate unrealized PnL
  IF v_execution.position_side = 'long' THEN
    v_unrealized_pnl := (p_current_price - v_execution.entry_price) *
                        v_execution.position_size_coin;
  ELSE
    v_unrealized_pnl := (v_execution.entry_price - p_current_price) *
                        v_execution.position_size_coin;
  END IF;

  -- Update MFE/MAE
  UPDATE trade_executions
  SET
    unrealized_pnl = v_unrealized_pnl,
    mfe = GREATEST(mfe, v_unrealized_pnl / v_execution.margin_used * 100),
    mae = LEAST(mae, v_unrealized_pnl / v_execution.margin_used * 100),
    mfe_price = CASE WHEN v_unrealized_pnl > 0 THEN GREATEST(mfe_price, p_current_price) ELSE mfe_price END,
    mae_price = CASE WHEN v_unrealized_pnl < 0 THEN LEAST(mae_price, p_current_price) ELSE mae_price END,
    updated_at = NOW()
  WHERE id = p_execution_id;

  RETURN v_unrealized_pnl;
END;
$$ LANGUAGE plpgsql;

-- Close trade execution
CREATE OR REPLACE FUNCTION close_trade_execution(
  p_execution_id BIGINT,
  p_exit_price NUMERIC,
  p_close_reason TEXT DEFAULT 'manual'
)
RETURNS TABLE (
  execution_id BIGINT,
  pnl NUMERIC,
  pnl_percent NUMERIC
) AS $$
DECLARE
  v_execution RECORD;
  v_pnl NUMERIC;
  v_pnl_percent NUMERIC;
BEGIN
  SELECT * INTO v_execution
  FROM trade_executions WHERE id = p_execution_id AND status = 'open';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Execution not found or not open';
  END IF;

  -- Calculate final PnL
  IF v_execution.position_side = 'long' THEN
    v_pnl := (p_exit_price - v_execution.entry_price) * v_execution.position_size_coin;
  ELSE
    v_pnl := (v_execution.entry_price - p_exit_price) * v_execution.position_size_coin;
  END IF;

  v_pnl_percent := (v_pnl / v_execution.margin_used) * 100;

  -- Update execution
  UPDATE trade_executions
  SET
    exit_price = p_exit_price,
    realized_pnl = v_pnl,
    realized_pnl_percent = v_pnl_percent,
    status = 'closed',
    close_reason = p_close_reason,
    closed_at = NOW(),
    duration_seconds = EXTRACT(EPOCH FROM (NOW() - opened_at)),
    updated_at = NOW()
  WHERE id = p_execution_id;

  -- Create journal entry
  INSERT INTO trade_journal (execution_id, trade_type)
  VALUES (p_execution_id, 'day_trade')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT p_execution_id, v_pnl, v_pnl_percent;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Enable Realtime for trade_executions
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE trade_executions;

COMMENT ON TABLE trade_executions IS 'Live trade executions with PnL tracking';
COMMENT ON TABLE trade_journal IS 'Trade journal for learning and improvement';
COMMENT ON TABLE order_history IS 'Order history for debugging';
