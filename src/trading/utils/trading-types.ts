/**
 * BEHEMOTH Trading Types
 * Shared interfaces and types for the trading system
 */

// ============================================================
// Core Trading Types
// ============================================================

export type Side = 'buy' | 'sell';
export type PositionSide = 'long' | 'short';
export type SignalType = 'long' | 'short';
export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit';
export type ScannerTier = 'top10' | 'top20' | 'top50';

export type TradeStatus = 'pending' | 'open' | 'closing' | 'closed' | 'cancelled' | 'liquidated';
export type SignalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'emergency';
export type AlertType =
  | 'trade_opened'
  | 'trade_closed'
  | 'trade_stop_loss'
  | 'trade_take_profit'
  | 'drawdown_warning'
  | 'drawdown_critical'
  | 'daily_loss_limit'
  | 'emergency_stop'
  | 'system_error'
  | 'liquidation_warning'
  | 'signal_generated'
  | 'signal_expired'
  | 'risk_limit';

// ============================================================
// OHLCV Data
// ============================================================

export interface OHLCV {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  trades?: number;
  takerBuyVolume?: number;
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  bidQty: number;
  askQty: number;
  volume24h: number;
  quoteVolume24h: number;
  high24h: number;
  low24h: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  timestamp: Date;
}

// ============================================================
// Technical Indicators
// ============================================================

export interface TechnicalIndicators {
  // Trend
  ema9: number;
  ema21: number;
  ema50: number;
  ema200?: number;
  sma20: number;

  // Momentum
  rsi14: number;
  rsi7?: number;
  macd: {
    line: number;
    signal: number;
    histogram: number;
  };
  stoch?: {
    k: number;
    d: number;
  };

  // Volatility
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
    width: number;
  };
  atr14: number;
  atrPercent: number;

  // Volume
  obv: number;
  vwap: number;
  volumeSma20: number;
  volumeRatio: number;
}

export interface MarketStructure {
  trendDirection: 'bullish' | 'bearish' | 'sideways';
  trendStrength: number; // 0-100
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  breakoutLevel?: number;
  breakdownLevel?: number;
  orderBlockHigh?: number;
  orderBlockLow?: number;
  fairValueGapHigh?: number;
  fairValueGapLow?: number;
}

// ============================================================
// Order Flow
// ============================================================

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface Orderbook {
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: Date;
}

export interface OrderbookAnalysis {
  bidDepth: number;
  askDepth: number;
  bidAskRatio: number;
  spreadPercent: number;
  imbalance: number; // -1 to 1, negative = sell pressure
  largeBidWalls: OrderbookLevel[];
  largeAskWalls: OrderbookLevel[];
  supportLevels: number[];
  resistanceLevels: number[];
}

export interface FundingRate {
  symbol: string;
  fundingRate: number;
  fundingTimestamp: Date;
  nextFundingTimestamp: Date;
  predictedRate?: number;
}

// ============================================================
// Liquidation Data
// ============================================================

export interface LiquidationEvent {
  exchange: string;
  symbol: string;
  side: Side;
  price: number;
  quantity: number;
  usdValue: number;
  orderType: string;
  timestamp: Date;
}

export interface LiquidationSummary {
  symbol: string;
  bucketStart: Date;
  bucketEnd: Date;
  longCount: number;
  longTotalUsd: number;
  shortCount: number;
  shortTotalUsd: number;
  netUsd: number;
  dominantSide: 'long' | 'short' | 'neutral';
}

// ============================================================
// Signal Types
// ============================================================

export interface SignalLayerScores {
  technical: number; // 0-100
  orderflow: number; // 0-100
  liquidation: number; // 0-100
  sentiment: number; // 0-100
  aiMl: number; // 0-100
  cosmic: number; // 0-100
}

export interface SignalLayerWeights {
  technical: number; // 0-1
  orderflow: number;
  liquidation: number;
  sentiment: number;
  aiMl: number;
  cosmic: number;
}

export interface SignalLayerReasons {
  technical?: string;
  orderflow?: string;
  liquidation?: string;
  sentiment?: string;
  aiMl?: string;
  cosmic?: string;
}

export interface TradingSignal {
  id?: string;
  symbol: string;
  signalType: SignalType;
  confidence: number; // 0-100
  signalStrength: number; // 0-100

  entryPrice: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit3?: number;
  riskRewardRatio?: number;

  layerScores: SignalLayerScores;
  layerWeights: SignalLayerWeights;
  layerReasons: SignalLayerReasons;

  reasoning?: string;
  scannerTier: ScannerTier;
  scannerIntervalSeconds: number;

  status: SignalStatus;
  createdAt: Date;
  expiresAt: Date;

  executedAt?: Date;
  executionId?: string;
}

// ============================================================
// Trade Execution Types
// ============================================================

export interface TradeExecution {
  id?: string;
  signalId?: string;

  symbol: string;
  side: Side;
  positionSide: PositionSide;
  orderType: OrderType;

  positionSizeUsd: number;
  positionSizeCoin: number;
  leverage: number;
  marginUsed: number;
  notionalValue: number;

  entryPrice: number;
  exitPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;

  exchange: string;
  exchangeOrderId?: string;
  exchangePositionId?: string;
  clientOrderId?: string;

  realizedPnl: number;
  realizedPnlPercent: number;
  unrealizedPnl: number;
  fundingFees: number;
  tradingFees: number;

  status: TradeStatus;
  closeReason?:
    | 'take_profit'
    | 'stop_loss'
    | 'trailing_stop'
    | 'manual'
    | 'emergency'
    | 'liquidation'
    | 'signal_reversal'
    | 'time_exit'
    | 'risk_limit';

  mfe?: number; // Maximum Favorable Excursion
  mae?: number; // Maximum Adverse Excursion
  mfePrice?: number;
  maePrice?: number;

  openedAt?: Date;
  closedAt?: Date;
  durationSeconds?: number;

  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Risk Types
// ============================================================

export interface RiskMetrics {
  tradingDate: Date;
  dailyPnl: number;
  dailyPnlPercent: number;
  dailyTrades: number;
  dailyWins: number;
  dailyLosses: number;
  dailyWinRate: number;

  currentDrawdown: number;
  maxDrawdown: number;

  openPositions: number;
  totalExposureUsd: number;
  maxSingleExposureUsd: number;
  currentLeverageAvg: number;
  maxLeverageUsed: number;

  dailyLossLimit: number;
  maxDrawdownLimit: number;
  maxPositions: number;
  maxPositionSizePercent: number;

  emergencyStopTriggered: boolean;
  tradingEnabled: boolean;
  tradingPausedUntil?: Date;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  warnings?: string[];
}

// ============================================================
// Alert Types
// ============================================================

export interface Alert {
  id?: string;
  alertType: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;

  symbol?: string;
  executionId?: string;
  signalId?: string;

  voiceAlert: boolean;
  voiceMessage?: string;

  acknowledged: boolean;
  acknowledgedAt?: Date;

  telegramSent: boolean;
  telegramMessageId?: string;

  createdAt: Date;
}

// ============================================================
// ML Types
// ============================================================

export interface MLPrediction {
  modelId: string;
  symbol: string;
  predictionTime: Date;
  targetTime: Date;

  predictedDirection: 'up' | 'down' | 'neutral';
  predictedReturn: number;
  predictedPrice: number;
  confidence: number;

  probUp: number;
  probDown: number;
  probNeutral: number;

  actualDirection?: 'up' | 'down' | 'neutral';
  actualReturn?: number;
  actualPrice?: number;
  isCorrect?: boolean;
}

// ============================================================
// Configuration Types
// ============================================================

export interface ScannerConfig {
  symbols: string[];
  intervalSeconds: number;
  tier: ScannerTier;
  confidenceThreshold: number;
}

export interface LeverageTier {
  minConfidence: number;
  minStrength: number;
  leverage: number;
}

export interface TradingConfig {
  minPositionUsd: number;
  maxPositionUsd: number;
  defaultLeverage: number;
  maxLeverage: number;
  leverageTiers: LeverageTier[];

  dailyLossLimit: number;
  maxDrawdown: number;
  maxPositions: number;
  positionSizePercent: number;

  signalConfidenceThreshold: Record<ScannerTier, number>;
  signalExpirySeconds: number;
}

// ============================================================
// WebSocket Types
// ============================================================

export interface WSMessage {
  topic: string;
  event: string;
  data: unknown;
  timestamp: Date;
}

export interface WSStatus {
  exchange: string;
  connected: boolean;
  lastMessage?: Date;
  reconnectCount: number;
  error?: string;
}

// ============================================================
// Journal Types
// ============================================================

export interface TradeJournal {
  executionId: string;
  tradeType: 'scalp' | 'day_trade' | 'swing' | 'position';
  marketCondition: 'trending_up' | 'trending_down' | 'ranging' | 'volatile' | 'calm';
  session: 'asian' | 'london' | 'new_york' | 'overlap';

  setupQuality: number; // 1-5
  entryQuality: number; // 1-5
  exitQuality: number; // 1-5

  fomoScore?: number; // 1-5
  revengeTrading?: boolean;
  followedPlan: boolean;

  whatWorked?: string;
  whatDidntWork?: string;
  lessonLearned?: string;
  improvementAction?: string;

  patternTags: string[];
}

// ============================================================
// API Response Types
// ============================================================

export interface ExchangeBalance {
  currency: string;
  total: number;
  free: number;
  used: number;
}

export interface ExchangePosition {
  symbol: string;
  side: PositionSide;
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ExchangeOrder {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  price?: number;
  quantity: number;
  filledQuantity: number;
  status: 'new' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Helper Functions
// ============================================================

export function calculatePnlPercent(
  entryPrice: number,
  exitPrice: number,
  side: PositionSide
): number {
  if (side === 'long') {
    return ((exitPrice - entryPrice) / entryPrice) * 100;
  } else {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }
}

export function calculateRiskReward(
  entryPrice: number,
  stopLoss: number,
  takeProfit: number
): number {
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  return reward / risk;
}

export function formatPrice(price: number, decimals: number = 2): string {
  return price.toFixed(decimals);
}

export function formatPercent(value: number, decimals: number = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

export function formatUSD(value: number, decimals: number = 2): string {
  return `$${value.toFixed(decimals)}`;
}
