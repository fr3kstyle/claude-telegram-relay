-- RLS Audit Fix: Add row-level security to tables missing it
--
-- Tables identified without RLS:
-- 1. Trading system tables (ohlcv_1m, technical_features, market_structure, etc.)
-- 2. Self-improvement tables (self_improvement_tests, improvement_metrics, etc.)
-- 3. Reflections and experience_replay tables
--
-- Security model: All tables use service_role only, as this is a single-tenant
-- personal relay with no user authentication. RLS provides defense-in-depth.

-- ============================================================
-- TRADING MARKET DATA TABLES
-- ============================================================

ALTER TABLE ohlcv_1m ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_ohlcv" ON ohlcv_1m FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE technical_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_technical_features" ON technical_features FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE market_structure ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_market_structure" ON market_structure FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- TRADING SIGNALS TABLES
-- ============================================================

ALTER TABLE trading_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_trading_signals" ON trading_signals FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE signal_weights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_signal_weights" ON signal_weights FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE signal_performance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_signal_performance" ON signal_performance FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- TRADING EXECUTIONS TABLES
-- ============================================================

ALTER TABLE trade_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_trade_executions" ON trade_executions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE trade_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_trade_journal" ON trade_journal FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE order_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_order_history" ON order_history FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- TRADING RISK TABLES
-- ============================================================

ALTER TABLE risk_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_risk_metrics" ON risk_metrics FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE account_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_account_history" ON account_history FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_alerts" ON alerts FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- TRADING ML TABLES
-- ============================================================

ALTER TABLE ml_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_ml_models" ON ml_models FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE ml_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_ml_predictions" ON ml_predictions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE strategy_performance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_strategy_performance" ON strategy_performance FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE mined_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_mined_patterns" ON mined_patterns FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- TRADING SYSTEM TABLES
-- ============================================================

ALTER TABLE system_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_system_events" ON system_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE liquidation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_liquidation_events" ON liquidation_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE liquidation_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_liquidation_summary" ON liquidation_summary FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE trading_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_trading_config" ON trading_config FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE scanner_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_scanner_state" ON scanner_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- SELF-IMPROVEMENT TABLES
-- ============================================================

ALTER TABLE self_improvement_tests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_self_improvement_tests" ON self_improvement_tests FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE improvement_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_improvement_metrics" ON improvement_metrics FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE improvement_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_improvement_logs" ON improvement_logs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- REFLECTION TABLES
-- ============================================================

ALTER TABLE reflections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_reflections" ON reflections FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE experience_replay ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_experience_replay" ON experience_replay FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- VERIFICATION QUERY (run after migration)
-- ============================================================
-- This query shows all tables and their RLS status:
--
-- SELECT schemaname, tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY tablename;
