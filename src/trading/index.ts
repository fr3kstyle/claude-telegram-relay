/**
 * BEHEMOTH Trading System
 *
 * Autonomous trading system integrated with claude-telegram-relay
 *
 * Architecture:
 * - Scanners: Monitor market data at different frequencies (top10, top20, top50)
 * - Engine: Signal generation, trade execution, risk management, position management
 * - Analysis: Technical indicators, order flow, ML predictions
 * - Learning: Trade journaling, pattern mining
 * - Alerts: Telegram notifications, voice alerts
 */

// Re-export main classes
export { BaseScanner, getScannerConfig } from './scanners/base-scanner';
export { Top10Scanner } from './scanners/top10-scanner';
export { Top20Scanner } from './scanners/top20-scanner';
export { Top50Scanner } from './scanners/top50-scanner';
export { BybitWSManager, BinanceWSManager, StreamManager } from './scanners/websocket-stream';

export { SignalGenerator, CONFIDENCE_THRESHOLDS, DEFAULT_WEIGHTS } from './engine/signal-generator';
export { TradeExecutor } from './engine/trade-executor';
export { RiskManager } from './engine/risk-manager';
export { PositionManager } from './engine/position-manager';

export { TradeJournalManager } from './learning/trade-journal';
export { PatternMiner } from './learning/pattern-miner';

export { TelegramAlerter, TradingCommands } from './alerts/telegram-alerter';
export { VoiceResponder } from './alerts/voice-responder';

export * from './utils/trading-types';
export * from './utils/kelly-sizing';

// Analysis exports
export {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateAllIndicators,
  analyzeMarketStructure,
  detectCandlePatterns,
} from './analysis/technical';

export {
  analyzeOrderbook,
  calculateOrderFlowScore,
  analyzeFundingRate,
} from './analysis/orderflow';

export {
  extractFeatures,
  predictNextMove,
  ensemblePredict,
} from './analysis/ml-predictor';
