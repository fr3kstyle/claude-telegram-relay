/**
 * BEHEMOTH Kelly Criterion Position Sizing
 *
 * Calculates optimal position size using the Kelly Criterion
 * with adjustments for risk management and overbetting protection.
 */

import type { TradingConfig, RiskMetrics } from './trading-types';

// ============================================================
// Kelly Criterion Implementation
// ============================================================

/**
 * Calculate Kelly fraction
 *
 * Kelly % = W - [(1 - W) / R]
 * Where:
 *   W = Winning probability (win rate)
 *   R = Win/loss ratio (average win / average loss)
 */
export function calculateKellyFraction(
  winRate: number, // 0-1
  avgWin: number,
  avgLoss: number
): number {
  if (avgLoss === 0) return 0;
  if (winRate <= 0 || winRate >= 1) return 0;

  const R = Math.abs(avgWin / avgLoss);
  const kelly = winRate - (1 - winRate) / R;

  // Kelly can be negative (don't bet) or > 1 (invalid)
  return Math.max(0, Math.min(1, kelly));
}

/**
 * Calculate fractional Kelly (more conservative)
 *
 * Full Kelly is too aggressive for trading.
 * Half Kelly is commonly recommended.
 */
export function calculateFractionalKelly(
  winRate: number,
  avgWin: number,
  avgLoss: number,
  fraction: number = 0.5 // Half Kelly by default
): number {
  const fullKelly = calculateKellyFraction(winRate, avgWin, avgLoss);
  return fullKelly * fraction;
}

// ============================================================
// Position Sizing
// ============================================================

export interface PositionSizeParams {
  accountBalance: number;
  winRate: number;
  avgWinPercent: number;
  avgLossPercent: number;
  signalConfidence: number; // 0-100
  signalStrength: number; // 0-100
  currentExposure: number;
  maxExposurePercent: number;
  kellyFraction: number;
}

export interface PositionSizeResult {
  positionSizeUsd: number;
  kellyPercent: number;
  adjustedKellyPercent: number;
  leverage: number;
  marginUsed: number;
  warnings: string[];
}

/**
 * Calculate optimal position size with all constraints
 */
export function calculatePositionSize(
  params: PositionSizeParams,
  config: TradingConfig
): PositionSizeResult {
  const warnings: string[] = [];

  // Calculate base Kelly
  const baseKelly = calculateFractionalKelly(
    params.winRate,
    params.avgWinPercent,
    params.avgLossPercent,
    params.kellyFraction
  );

  // Adjust Kelly based on signal confidence
  const confidenceMultiplier = params.signalConfidence / 100;
  const strengthMultiplier = params.signalStrength / 100;

  // Weighted adjustment
  let adjustedKelly = baseKelly * confidenceMultiplier * strengthMultiplier;

  // Cap at max position size percent
  const maxPositionPercent = config.maxPositionSizePercent / 100;
  adjustedKelly = Math.min(adjustedKelly, maxPositionPercent);

  // Calculate position size
  let positionSizeUsd = params.accountBalance * adjustedKelly;

  // Apply min/max constraints
  if (positionSizeUsd < config.minPositionUsd) {
    warnings.push(`Position size below minimum ($${config.minPositionUsd})`);
    positionSizeUsd = 0; // Don't trade
  }

  if (positionSizeUsd > config.maxPositionUsd) {
    warnings.push(`Position size capped at maximum ($${config.maxPositionUsd})`);
    positionSizeUsd = config.maxPositionUsd;
  }

  // Check total exposure
  const newExposure = params.currentExposure + positionSizeUsd;
  const maxExposure = params.accountBalance * (params.maxExposurePercent / 100);

  if (newExposure > maxExposure) {
    const availableExposure = maxExposure - params.currentExposure;
    if (availableExposure <= 0) {
      warnings.push('Max exposure already reached - no position allowed');
      positionSizeUsd = 0;
    } else {
      warnings.push(`Position reduced due to exposure limit`);
      positionSizeUsd = Math.min(positionSizeUsd, availableExposure);
    }
  }

  // Calculate leverage based on confidence and strength
  const leverage = calculateLeverage(params.signalConfidence, params.signalStrength, config);
  const marginUsed = positionSizeUsd;

  return {
    positionSizeUsd,
    kellyPercent: baseKelly * 100,
    adjustedKellyPercent: adjustedKelly * 100,
    leverage,
    marginUsed,
    warnings,
  };
}

// ============================================================
// Dynamic Leverage Calculation
// ============================================================

/**
 * Calculate leverage based on confidence and signal strength
 *
 * Higher confidence + higher strength = higher leverage (up to max)
 */
export function calculateLeverage(
  confidence: number, // 0-100
  signalStrength: number, // 0-100
  config: TradingConfig
): number {
  // Find appropriate leverage tier
  for (const tier of config.leverageTiers) {
    if (confidence >= tier.minConfidence && signalStrength >= tier.minStrength) {
      return Math.min(tier.leverage, config.maxLeverage);
    }
  }

  // Default to lower leverage if no tier matches
  return Math.min(config.defaultLeverage, config.maxLeverage);
}

/**
 * Get leverage tier description
 */
export function getLeverageTierDescription(confidence: number, strength: number, config: TradingConfig): string {
  if (confidence >= 95 && strength >= 85) {
    return `MAX (${config.maxLeverage}x) - Exceptional signal`;
  }
  if (confidence >= 85) {
    return 'HIGH (100x) - Strong signal';
  }
  if (confidence >= 75) {
    return 'MEDIUM (75x) - Good signal';
  }
  if (confidence >= 70) {
    return 'LOW (50x) - Acceptable signal';
  }
  return 'NO TRADE - Confidence too low';
}

// ============================================================
// Risk-Adjusted Returns
// ============================================================

/**
 * Calculate Sharpe Ratio from returns
 */
export function calculateSharpeRatio(
  returns: number[],
  riskFreeRate: number = 0.04 // 4% annual risk-free rate
): number {
  if (returns.length < 2) return 0;

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
    (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize assuming daily returns
  const annualizedReturn = avgReturn * 252;
  const annualizedStdDev = stdDev * Math.sqrt(252);

  return (annualizedReturn - riskFreeRate) / annualizedStdDev;
}

/**
 * Calculate Sortino Ratio (only penalizes downside)
 */
export function calculateSortinoRatio(
  returns: number[],
  riskFreeRate: number = 0.04
): number {
  if (returns.length < 2) return 0;

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const negativeReturns = returns.filter((r) => r < 0);

  if (negativeReturns.length === 0) return Infinity;

  const downsideVariance =
    negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) /
    negativeReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);

  if (downsideDev === 0) return 0;

  const annualizedReturn = avgReturn * 252;
  const annualizedDownside = downsideDev * Math.sqrt(252);

  return (annualizedReturn - riskFreeRate) / annualizedDownside;
}

/**
 * Calculate Maximum Drawdown
 */
export function calculateMaxDrawdown(equityCurve: number[]): {
  maxDrawdown: number;
  peakValue: number;
  troughValue: number;
  peakIndex: number;
  troughIndex: number;
} {
  if (equityCurve.length < 2) {
    return {
      maxDrawdown: 0,
      peakValue: equityCurve[0] || 0,
      troughValue: equityCurve[0] || 0,
      peakIndex: 0,
      troughIndex: 0,
    };
  }

  let maxDrawdown = 0;
  let peak = equityCurve[0];
  let peakIndex = 0;
  let trough = equityCurve[0];
  let troughIndex = 0;
  let tempPeakIndex = 0;

  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i] > peak) {
      peak = equityCurve[i];
      tempPeakIndex = i;
    }

    const drawdown = (peak - equityCurve[i]) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      trough = equityCurve[i];
      peakIndex = tempPeakIndex;
      troughIndex = i;
    }
  }

  return {
    maxDrawdown: maxDrawdown * 100, // Return as percentage
    peakValue: peak,
    troughValue: trough,
    peakIndex,
    troughIndex,
  };
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Calculate win rate from trades
 */
export function calculateWinRate(wins: number, total: number): number {
  if (total === 0) return 0;
  return (wins / total) * 100;
}

/**
 * Calculate profit factor
 */
export function calculateProfitFactor(grossProfit: number, grossLoss: number): number {
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
  return Math.abs(grossProfit / grossLoss);
}

/**
 * Calculate expectancy
 */
export function calculateExpectancy(
  winRate: number,
  avgWin: number,
  avgLoss: number
): number {
  return winRate * avgWin - (1 - winRate) * Math.abs(avgLoss);
}

/**
 * Get recommended position size for display
 */
export function getRecommendedPositionSize(
  accountBalance: number,
  riskPercent: number = 2, // Risk 2% per trade
  entryPrice: number,
  stopLossPrice: number
): number {
  const riskAmount = accountBalance * (riskPercent / 100);
  const riskPerCoin = Math.abs(entryPrice - stopLossPrice);

  if (riskPerCoin === 0) return 0;

  return riskAmount / riskPerCoin;
}
