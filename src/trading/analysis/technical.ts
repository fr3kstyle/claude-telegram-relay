/**
 * BEHEMOTH Technical Analysis Module
 *
 * Comprehensive technical indicator calculations:
 * - Trend indicators (EMA, SMA)
 * - Momentum indicators (RSI, MACD, Stochastic)
 * - Volatility indicators (Bollinger Bands, ATR)
 * - Volume indicators (OBV, VWAP)
 */

import type { OHLCV, TechnicalIndicators, MarketStructure } from '../utils/trading-types';

// ============================================================
// Trend Indicators
// ============================================================

export function calculateSMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calculateEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;

  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }

  return ema;
}

export function calculateAllEMAs(closes: number[]): {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
} {
  return {
    ema9: calculateEMA(closes, 9),
    ema21: calculateEMA(closes, 21),
    ema50: calculateEMA(closes, 50),
    ema200: closes.length >= 200 ? calculateEMA(closes, 200) : 0,
  };
}

// ============================================================
// Momentum Indicators
// ============================================================

export function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  // First calculation
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed calculation
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - change) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateMACD(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { line: number; signal: number; histogram: number } {
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);
  const line = emaFast - emaSlow;

  // Calculate signal line (EMA of MACD line)
  // For simplicity, we'll approximate with recent MACD values
  const macdHistory: number[] = [];
  for (let i = Math.max(fastPeriod, slowPeriod); i < closes.length; i++) {
    const fast = calculateEMA(closes.slice(0, i + 1), fastPeriod);
    const slow = calculateEMA(closes.slice(0, i + 1), slowPeriod);
    macdHistory.push(fast - slow);
  }

  const signal = macdHistory.length >= signalPeriod
    ? calculateEMA(macdHistory, signalPeriod)
    : line;

  const histogram = line - signal;

  return { line, signal, histogram };
}

export function calculateStochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod: number = 14,
  dPeriod: number = 3
): { k: number; d: number } {
  if (closes.length < kPeriod) return { k: 50, d: 50 };

  const recentHighs = highs.slice(-kPeriod);
  const recentLows = lows.slice(-kPeriod);
  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const currentClose = closes[closes.length - 1];

  if (highestHigh === lowestLow) return { k: 50, d: 50 };

  const k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;

  // Calculate %D (SMA of %K)
  const kHistory: number[] = [];
  for (let i = kPeriod; i <= closes.length; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod, i));
    const ll = Math.min(...lows.slice(i - kPeriod, i));
    const c = closes[i - 1];
    if (hh !== ll) {
      kHistory.push(((c - ll) / (hh - ll)) * 100);
    }
  }

  const d = kHistory.length >= dPeriod
    ? calculateSMA(kHistory.slice(-dPeriod), dPeriod)
    : k;

  return { k, d };
}

// ============================================================
// Volatility Indicators
// ============================================================

export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): { upper: number; middle: number; lower: number; width: number } {
  const middle = calculateSMA(closes, period);

  if (closes.length < period) {
    return { upper: middle * 1.02, middle, lower: middle * 0.98, width: 4 };
  }

  const slice = closes.slice(-period);
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;
  const width = ((upper - lower) / middle) * 100;

  return { upper, middle, lower, width };
}

export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number {
  if (closes.length < period + 1) return 0;

  const trueRanges: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // First ATR is SMA of TR
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Subsequent ATRs are smoothed
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

export function calculateATRPercent(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number {
  const atr = calculateATR(highs, lows, closes, period);
  const price = closes[closes.length - 1];
  return price > 0 ? (atr / price) * 100 : 0;
}

// ============================================================
// Volume Indicators
// ============================================================

export function calculateOBV(closes: number[], volumes: number[]): number {
  if (closes.length !== volumes.length || closes.length < 2) return 0;

  let obv = 0;

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv += volumes[i];
    } else if (closes[i] < closes[i - 1]) {
      obv -= volumes[i];
    }
  }

  return obv;
}

export function calculateVWAP(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[]
): number {
  if (closes.length === 0) return 0;

  let sumPV = 0;
  let sumVolume = 0;

  for (let i = 0; i < closes.length; i++) {
    const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
    sumPV += typicalPrice * volumes[i];
    sumVolume += volumes[i];
  }

  return sumVolume > 0 ? sumPV / sumVolume : closes[closes.length - 1];
}

// ============================================================
// Support/Resistance
// ============================================================

export function calculatePivotPoints(
  high: number,
  low: number,
  close: number
): {
  pivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
} {
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const r2 = pivot + (high - low);
  const r3 = high + 2 * (pivot - low);
  const s1 = 2 * pivot - high;
  const s2 = pivot - (high - low);
  const s3 = low - 2 * (high - pivot);

  return { pivot, r1, r2, r3, s1, s2, s3 };
}

// ============================================================
// Complete Technical Analysis
// ============================================================

export function calculateAllIndicators(candles: OHLCV[]): TechnicalIndicators {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const emas = calculateAllEMAs(closes);
  const rsi14 = calculateRSI(closes, 14);
  const rsi7 = calculateRSI(closes, 7);
  const macd = calculateMACD(closes);
  const stoch = calculateStochastic(highs, lows, closes);
  const bb = calculateBollingerBands(closes);
  const atr14 = calculateATR(highs, lows, closes, 14);
  const atrPercent = calculateATRPercent(highs, lows, closes, 14);
  const obv = calculateOBV(closes, volumes);
  const vwap = calculateVWAP(highs, lows, closes, volumes);
  const volumeSma20 = calculateSMA(volumes, 20);

  return {
    ...emas,
    sma20: calculateSMA(closes, 20),
    rsi14,
    rsi7,
    macd,
    stoch,
    bollingerBands: bb,
    atr14,
    atrPercent,
    obv,
    vwap,
    volumeSma20,
    volumeRatio: volumeSma20 > 0 ? volumes[volumes.length - 1] / volumeSma20 : 1,
  };
}

// ============================================================
// Market Structure Analysis
// ============================================================

export function analyzeMarketStructure(candles: OHLCV[]): MarketStructure {
  if (candles.length < 20) {
    return {
      trendDirection: 'sideways',
      trendStrength: 50,
      higherHigh: false,
      higherLow: false,
      lowerHigh: false,
      lowerLow: false,
    };
  }

  const recentCandles = candles.slice(-20);
  const highs = recentCandles.map((c) => c.high);
  const lows = recentCandles.map((c) => c.low);
  const closes = recentCandles.map((c) => c.close);

  // Find swing highs and lows
  let higherHigh = false;
  let higherLow = false;
  let lowerHigh = false;
  let lowerLow = false;

  for (let i = 2; i < recentCandles.length - 2; i++) {
    // Swing high
    if (
      highs[i] > highs[i - 1] &&
      highs[i] > highs[i - 2] &&
      highs[i] > highs[i + 1] &&
      highs[i] > highs[i + 2]
    ) {
      // Check if it's higher than previous swing high
      for (let j = i - 3; j >= 2; j--) {
        if (
          highs[j] > highs[j - 1] &&
          highs[j] > highs[j - 2] &&
          highs[j] > highs[j + 1] &&
          highs[j] > highs[j + 2]
        ) {
          if (highs[i] > highs[j]) higherHigh = true;
          else lowerHigh = true;
          break;
        }
      }
    }

    // Swing low
    if (
      lows[i] < lows[i - 1] &&
      lows[i] < lows[i - 2] &&
      lows[i] < lows[i + 1] &&
      lows[i] < lows[i + 2]
    ) {
      for (let j = i - 3; j >= 2; j--) {
        if (
          lows[j] < lows[j - 1] &&
          lows[j] < lows[j - 2] &&
          lows[j] < lows[j + 1] &&
          lows[j] < lows[j + 2]
        ) {
          if (lows[i] > lows[j]) higherLow = true;
          else lowerLow = true;
          break;
        }
      }
    }
  }

  // Determine trend direction
  let trendDirection: 'bullish' | 'bearish' | 'sideways' = 'sideways';
  let trendStrength = 50;

  if (higherHigh && higherLow) {
    trendDirection = 'bullish';
    trendStrength = 75;
  } else if (lowerHigh && lowerLow) {
    trendDirection = 'bearish';
    trendStrength = 75;
  } else if (higherHigh || higherLow) {
    trendDirection = 'bullish';
    trendStrength = 60;
  } else if (lowerHigh || lowerLow) {
    trendDirection = 'bearish';
    trendStrength = 60;
  }

  // Check EMAs for additional trend confirmation
  const closesAll = candles.map((c) => c.close);
  const ema9 = calculateEMA(closesAll, 9);
  const ema21 = calculateEMA(closesAll, 21);
  const currentPrice = closes[closes.length - 1];

  if (ema9 > ema21 && currentPrice > ema9) {
    if (trendDirection === 'bullish') trendStrength = Math.min(100, trendStrength + 15);
    else trendDirection = 'bullish';
  } else if (ema9 < ema21 && currentPrice < ema9) {
    if (trendDirection === 'bearish') trendStrength = Math.min(100, trendStrength + 15);
    else trendDirection = 'bearish';
  }

  return {
    trendDirection,
    trendStrength,
    higherHigh,
    higherLow,
    lowerHigh,
    lowerLow,
  };
}

// ============================================================
// Pattern Detection
// ============================================================

export interface CandlePattern {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  strength: number; // 0-100
}

export function detectCandlePatterns(candles: OHLCV[]): CandlePattern[] {
  const patterns: CandlePattern[] = [];

  if (candles.length < 3) return patterns;

  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  // Doji
  const bodySize = Math.abs(current.close - current.open);
  const totalRange = current.high - current.low;
  if (bodySize < totalRange * 0.1) {
    patterns.push({ name: 'doji', type: 'neutral', strength: 50 });
  }

  // Hammer
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);
  if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) {
    patterns.push({ name: 'hammer', type: 'bullish', strength: 65 });
  }

  // Inverted Hammer
  if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5) {
    patterns.push({ name: 'inverted_hammer', type: 'bullish', strength: 60 });
  }

  // Engulfing
  const currentBody = current.close - current.open;
  const prevBody = prev.close - prev.open;
  const maxCurrent = Math.max(current.open, current.close);
  const minCurrent = Math.min(current.open, current.close);
  const maxPrev = Math.max(prev.open, prev.close);
  const minPrev = Math.min(prev.open, prev.close);

  if (
    currentBody > 0 &&
    prevBody < 0 &&
    maxCurrent > maxPrev &&
    minCurrent < minPrev
  ) {
    patterns.push({ name: 'bullish_engulfing', type: 'bullish', strength: 75 });
  }

  if (
    currentBody < 0 &&
    prevBody > 0 &&
    maxCurrent > maxPrev &&
    minCurrent < minPrev
  ) {
    patterns.push({ name: 'bearish_engulfing', type: 'bearish', strength: 75 });
  }

  // Three White Soldiers
  if (candles.length >= 3) {
    const allBullish =
      currentBody > 0 &&
      prevBody > 0 &&
      (prev2.close - prev2.open) > 0;
    const allHigher =
      current.close > prev.close &&
      prev.close > prev2.close;

    if (allBullish && allHigher) {
      patterns.push({ name: 'three_white_soldiers', type: 'bullish', strength: 80 });
    }
  }

  // Three Black Crows
  if (candles.length >= 3) {
    const allBearish =
      currentBody < 0 &&
      prevBody < 0 &&
      (prev2.close - prev2.open) < 0;
    const allLower =
      current.close < prev.close &&
      prev.close < prev2.close;

    if (allBearish && allLower) {
      patterns.push({ name: 'three_black_crows', type: 'bearish', strength: 80 });
    }
  }

  return patterns;
}
