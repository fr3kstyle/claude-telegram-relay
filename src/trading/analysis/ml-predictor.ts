/**
 * BEHEMOTH ML Predictor Module
 *
 * Machine learning predictions for price movement:
 * - Feature extraction
 * - LSTM-style predictions
 * - Ensemble predictions
 */

import type { OHLCV, TechnicalIndicators, MLPrediction } from '../utils/trading-types';
import { calculateAllIndicators } from './technical';

// ============================================================
// Feature Extraction
// ============================================================

export interface MLFeatures {
  // Price features
  returns_1m: number;
  returns_5m: number;
  returns_15m: number;
  returns_1h: number;

  // Volatility features
  volatility_5m: number;
  volatility_15m: number;
  volatility_1h: number;

  // Technical features (normalized)
  rsi_normalized: number;
  macd_normalized: number;
  bb_position: number;

  // Volume features
  volume_ratio: number;
  obv_trend: number;

  // Microstructure
  spread_estimate: number;
  momentum_5m: number;
  momentum_15m: number;
}

export function extractFeatures(candles: OHLCV[]): MLFeatures {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const len = closes.length;

  // Returns
  const returns_1m = len >= 2 ? (closes[len - 1] - closes[len - 2]) / closes[len - 2] : 0;
  const returns_5m = len >= 6 ? (closes[len - 1] - closes[len - 6]) / closes[len - 6] : 0;
  const returns_15m = len >= 16 ? (closes[len - 1] - closes[len - 16]) / closes[len - 16] : 0;
  const returns_1h = len >= 61 ? (closes[len - 1] - closes[len - 61]) / closes[len - 61] : 0;

  // Volatility (std dev of returns)
  const volatility_5m = calculateVolatility(closes, 5);
  const volatility_15m = calculateVolatility(closes, 15);
  const volatility_1h = calculateVolatility(closes, 60);

  // Technical indicators
  const indicators = calculateAllIndicators(candles);
  const rsi_normalized = indicators.rsi14 / 100; // 0-1 range
  const macd_normalized = normalizeMACD(indicators.macd.line, closes[len - 1]);
  const bb_position = calculateBBPosition(candles[len - 1].close, indicators.bollingerBands);

  // Volume
  const volumeSma = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);
  const volume_ratio = volumeSma > 0 ? volumes[len - 1] / volumeSma : 1;
  const obv_trend = calculateOBVTrend(candles);

  // Momentum
  const momentum_5m = calculateMomentum(closes, 5);
  const momentum_15m = calculateMomentum(closes, 15);

  return {
    returns_1m,
    returns_5m,
    returns_15m,
    returns_1h,
    volatility_5m,
    volatility_15m,
    volatility_1h,
    rsi_normalized,
    macd_normalized,
    bb_position,
    volume_ratio,
    obv_trend,
    spread_estimate: 0.001, // Placeholder
    momentum_5m,
    momentum_15m,
  };
}

function calculateVolatility(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;

  const returns: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

  return Math.sqrt(variance);
}

function normalizeMACD(macd: number, price: number): number {
  // Normalize MACD as % of price
  return price > 0 ? Math.tanh(macd / price * 100) : 0; // Tanh to bound to [-1, 1]
}

function calculateBBPosition(
  price: number,
  bb: { upper: number; middle: number; lower: number }
): number {
  if (bb.upper === bb.lower) return 0.5;
  return (price - bb.lower) / (bb.upper - bb.lower);
}

function calculateOBVTrend(candles: OHLCV[]): number {
  if (candles.length < 10) return 0;

  let obv = 0;
  const obvValues: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) {
      obv += candles[i].volume;
    } else if (candles[i].close < candles[i - 1].close) {
      obv -= candles[i].volume;
    }
    obvValues.push(obv);
  }

  // Linear regression slope of OBV
  const n = obvValues.length;
  const xMean = (n - 1) / 2;
  const yMean = obvValues.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (obvValues[i] - yMean);
    denominator += Math.pow(i - xMean, 2);
  }

  return denominator > 0 ? numerator / denominator / Math.abs(yMean + 1) : 0;
}

function calculateMomentum(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;

  const roc: number[] = [];
  for (let i = period; i < closes.length; i++) {
    roc.push((closes[i] - closes[i - period]) / closes[i - period]);
  }

  // Average rate of change
  return roc.reduce((a, b) => a + b, 0) / roc.length;
}

// ============================================================
// Simple LSTM-Style Prediction
// ============================================================

export interface PredictionResult {
  direction: 'up' | 'down' | 'neutral';
  probability: number;
  confidence: number;
  expectedReturn: number;
  features: MLFeatures;
}

/**
 * Simple sequence-based prediction (LSTM-style without actual model)
 * In production, this would load a trained TensorFlow/ONNX model
 */
export function predictNextMove(candles: OHLCV[], horizonMinutes: number = 5): PredictionResult {
  const features = extractFeatures(candles);

  // Simple heuristic-based prediction (replace with actual model inference)
  let score = 0;
  let reasons: string[] = [];

  // Returns momentum
  if (features.returns_5m > 0.01) {
    score += 15;
    reasons.push('Positive 5m momentum');
  } else if (features.returns_5m < -0.01) {
    score -= 15;
    reasons.push('Negative 5m momentum');
  }

  // RSI extremes (contrarian)
  if (features.rsi_normalized < 0.3) {
    score += 20;
    reasons.push('RSI oversold');
  } else if (features.rsi_normalized > 0.7) {
    score -= 20;
    reasons.push('RSI overbought');
  }

  // BB position
  if (features.bb_position < 0.2) {
    score += 15;
    reasons.push('Price near lower BB');
  } else if (features.bb_position > 0.8) {
    score -= 15;
    reasons.push('Price near upper BB');
  }

  // Volume confirmation
  if (features.volume_ratio > 1.5) {
    score *= 1.2; // Amplify signal with volume
    reasons.push('High volume confirms');
  }

  // Volatility consideration
  if (features.volatility_5m > 0.02) {
    score *= 0.8; // Reduce confidence in high volatility
    reasons.push('High volatility reduces confidence');
  }

  // OBV trend
  if (features.obv_trend > 0.1) {
    score += 10;
    reasons.push('OBV trending up');
  } else if (features.obv_trend < -0.1) {
    score -= 10;
    reasons.push('OBV trending down');
  }

  // Normalize to probability
  const probability = Math.max(0, Math.min(100, 50 + score));

  // Determine direction
  let direction: 'up' | 'down' | 'neutral';
  if (probability > 55) {
    direction = 'up';
  } else if (probability < 45) {
    direction = 'down';
  } else {
    direction = 'neutral';
  }

  // Calculate confidence
  const confidence = Math.abs(probability - 50) * 2;

  // Expected return (simplified)
  const expectedReturn = (probability - 50) / 100 * features.volatility_15m * 2;

  return {
    direction,
    probability,
    confidence,
    expectedReturn,
    features,
  };
}

// ============================================================
// Ensemble Predictions
// ============================================================

export interface EnsemblePrediction {
  direction: 'up' | 'down' | 'neutral';
  probability: number;
  confidence: number;
  modelAgreement: number; // 0-1
  models: {
    name: string;
    prediction: PredictionResult;
    weight: number;
  }[];
}

/**
 * Combine multiple prediction methods
 */
export function ensemblePredict(candles: OHLCV[]): EnsemblePrediction {
  // Run multiple prediction approaches
  const predictions: { name: string; prediction: PredictionResult; weight: number }[] = [
    {
      name: 'momentum',
      prediction: momentumPredict(candles),
      weight: 0.3,
    },
    {
      name: 'mean_reversion',
      prediction: meanReversionPredict(candles),
      weight: 0.3,
    },
    {
      name: 'trend_follow',
      prediction: trendFollowPredict(candles),
      weight: 0.4,
    },
  ];

  // Weighted average probability
  let weightedProb = 0;
  let totalWeight = 0;

  for (const model of predictions) {
    const prob = model.prediction.direction === 'up'
      ? model.prediction.probability
      : model.prediction.direction === 'down'
      ? 100 - model.prediction.probability
      : 50;

    weightedProb += prob * model.weight;
    totalWeight += model.weight;
  }

  const avgProb = weightedProb / totalWeight;

  // Calculate agreement
  const upVotes = predictions.filter(p => p.prediction.direction === 'up').length;
  const downVotes = predictions.filter(p => p.prediction.direction === 'down').length;
  const modelAgreement = Math.max(upVotes, downVotes) / predictions.length;

  // Determine ensemble direction
  let direction: 'up' | 'down' | 'neutral';
  if (avgProb > 55) {
    direction = 'up';
  } else if (avgProb < 45) {
    direction = 'down';
  } else {
    direction = 'neutral';
  }

  // Confidence based on agreement and probability
  const confidence = (modelAgreement * 50) + (Math.abs(avgProb - 50));

  return {
    direction,
    probability: avgProb,
    confidence: Math.min(100, confidence),
    modelAgreement,
    models: predictions,
  };
}

function momentumPredict(candles: OHLCV[]): PredictionResult {
  const features = extractFeatures(candles);

  // Pure momentum strategy
  const momentum = (features.returns_5m + features.returns_15m) / 2;
  const probability = 50 + momentum * 500;

  return {
    direction: probability > 55 ? 'up' : probability < 45 ? 'down' : 'neutral',
    probability: Math.max(0, Math.min(100, probability)),
    confidence: Math.min(100, Math.abs(momentum) * 5000),
    expectedReturn: momentum,
    features,
  };
}

function meanReversionPredict(candles: OHLCV[]): PredictionResult {
  const features = extractFeatures(candles);

  // Contrarian strategy based on overextension
  let probability = 50;

  // RSI mean reversion
  if (features.rsi_normalized < 0.3) {
    probability += 20;
  } else if (features.rsi_normalized > 0.7) {
    probability -= 20;
  }

  // BB mean reversion
  if (features.bb_position < 0.15) {
    probability += 15;
  } else if (features.bb_position > 0.85) {
    probability -= 15;
  }

  return {
    direction: probability > 55 ? 'up' : probability < 45 ? 'down' : 'neutral',
    probability: Math.max(0, Math.min(100, probability)),
    confidence: Math.abs(features.rsi_normalized - 0.5) * 100,
    expectedReturn: (50 - probability) / 100 * 0.01,
    features,
  };
}

function trendFollowPredict(candles: OHLCV[]): PredictionResult {
  const features = extractFeatures(candles);

  // Trend following based on multiple timeframes
  const trend = (features.returns_15m + features.returns_1h) / 2;

  // Only trade if momentum confirms trend
  const momentumConfirm = features.momentum_5m > 0 === trend > 0;
  const probability = 50 + (momentumConfirm ? trend * 300 : trend * 150);

  return {
    direction: probability > 55 ? 'up' : probability < 45 ? 'down' : 'neutral',
    probability: Math.max(0, Math.min(100, probability)),
    confidence: momentumConfirm ? 70 : 40,
    expectedReturn: trend,
    features,
  };
}

// ============================================================
// Model Registry (for database integration)
// ============================================================

export interface ModelInfo {
  id: string;
  name: string;
  type: 'lstm' | 'transformer' | 'xgboost' | 'ensemble';
  version: string;
  accuracy: number;
  lastTrained: Date;
  isActive: boolean;
}

export const MODEL_REGISTRY: ModelInfo[] = [
  {
    id: 'ensemble_v1',
    name: 'Ensemble Predictor',
    type: 'ensemble',
    version: '1.0.0',
    accuracy: 0.58,
    lastTrained: new Date('2024-01-01'),
    isActive: true,
  },
];
