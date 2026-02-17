/**
 * BEHEMOTH Signal Generator
 *
 * 6-layer signal generation engine:
 * 1. Technical Analysis (35%)
 * 2. Order Flow (20%)
 * 3. Liquidation Analysis (15%)
 * 4. Sentiment (10%)
 * 5. AI/ML Predictions (15%)
 * 6. Cosmic Analysis (5%)
 */

import { createClient } from "@supabase/supabase-js";
import type {
  TradingSignal,
  SignalLayerScores,
  SignalLayerWeights,
  ScannerTier,
} from '../utils/trading-types';
import { calculatePositionSize, calculateLeverage } from '../utils/kelly-sizing';

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// Default layer weights
const DEFAULT_WEIGHTS: SignalLayerWeights = {
  technical: 0.35,
  orderflow: 0.20,
  liquidation: 0.15,
  sentiment: 0.10,
  aiMl: 0.15,
  cosmic: 0.05,
};

// Confidence thresholds by tier
const CONFIDENCE_THRESHOLDS: Record<ScannerTier, number> = {
  top10: 78,
  top20: 80,
  top50: 82,
};

// ============================================================
// Signal Generator Class
// ============================================================

export class SignalGenerator {
  private weights: SignalLayerWeights;
  private confidenceThreshold: number;

  constructor(
    tier: ScannerTier = 'top10',
    customWeights?: Partial<SignalLayerWeights>
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...customWeights };
    this.confidenceThreshold = CONFIDENCE_THRESHOLDS[tier];
  }

  /**
   * Generate a trading signal from layer scores
   */
  async generateSignal(params: {
    symbol: string;
    currentPrice: number;
    layerScores: SignalLayerScores;
    layerReasons: Record<string, string>;
    tier: ScannerTier;
    accountBalance: number;
    currentExposure: number;
    winRate: number;
    avgWinPercent: number;
    avgLossPercent: number;
  }): Promise<TradingSignal | null> {
    // Calculate weighted confidence
    const confidence = this.calculateWeightedConfidence(params.layerScores);

    // Check threshold
    if (confidence < this.confidenceThreshold) {
      console.log(
        `[Signal] ${params.symbol}: Confidence ${confidence.toFixed(1)}% below threshold ${this.confidenceThreshold}%`
      );
      return null;
    }

    // Calculate signal strength
    const signalStrength = this.calculateSignalStrength(params.layerScores);

    // Determine signal type
    const signalType = this.determineSignalType(params.layerScores, params.layerReasons);

    // Calculate position size using Kelly criterion
    const positionResult = calculatePositionSize(
      {
        accountBalance: params.accountBalance,
        winRate: params.winRate,
        avgWinPercent: params.avgWinPercent,
        avgLossPercent: params.avgLossPercent,
        signalConfidence: confidence,
        signalStrength: signalStrength,
        currentExposure: params.currentExposure,
        maxExposurePercent: 10, // 10% max total exposure
        kellyFraction: 0.5, // Half Kelly
      },
      {
        minPositionUsd: 2,
        maxPositionUsd: 10,
        defaultLeverage: 50,
        maxLeverage: 125,
        leverageTiers: [
          { minConfidence: 95, minStrength: 85, leverage: 125 },
          { minConfidence: 85, minStrength: 70, leverage: 100 },
          { minConfidence: 75, minStrength: 60, leverage: 75 },
          { minConfidence: 70, minStrength: 50, leverage: 50 },
        ],
        dailyLossLimit: 15,
        maxDrawdown: 30,
        maxPositions: 2,
        positionSizePercent: 5,
        signalConfidenceThreshold: CONFIDENCE_THRESHOLDS,
        signalExpirySeconds: 300,
      }
    );

    if (positionResult.positionSizeUsd === 0) {
      console.log(`[Signal] ${params.symbol}: Position size zero - ${positionResult.warnings.join(', ')}`);
      return null;
    }

    // Calculate price levels
    const levels = this.calculatePriceLevels(
      params.currentPrice,
      signalType,
      positionResult.leverage
    );

    const signal: TradingSignal = {
      symbol: params.symbol,
      signalType,
      confidence,
      signalStrength,
      entryPrice: params.currentPrice,
      stopLoss: levels.stopLoss,
      takeProfit1: levels.takeProfit1,
      takeProfit2: levels.takeProfit2,
      takeProfit3: levels.takeProfit3,
      riskRewardRatio: levels.riskReward,
      layerScores: params.layerScores,
      layerWeights: this.weights,
      layerReasons: params.layerReasons,
      scannerTier: params.tier,
      scannerIntervalSeconds: params.tier === 'top10' ? 60 : params.tier === 'top20' ? 120 : 600,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    // Save to database
    const savedSignal = await this.saveSignal(signal);

    return savedSignal || signal;
  }

  /**
   * Calculate weighted confidence score
   */
  private calculateWeightedConfidence(scores: SignalLayerScores): number {
    return (
      scores.technical * this.weights.technical +
      scores.orderflow * this.weights.orderflow +
      scores.liquidation * this.weights.liquidation +
      scores.sentiment * this.weights.sentiment +
      scores.aiMl * this.weights.aiMl +
      scores.cosmic * this.weights.cosmic
    );
  }

  /**
   * Calculate signal strength (average of top 3 layers)
   */
  private calculateSignalStrength(scores: SignalLayerScores): number {
    const sortedScores = Object.values(scores).sort((a, b) => b - a);
    return (sortedScores[0] + sortedScores[1] + sortedScores[2]) / 3;
  }

  /**
   * Determine signal direction from layer analysis
   */
  private determineSignalType(
    scores: SignalLayerScores,
    reasons: Record<string, string>
  ): 'long' | 'short' {
    let longScore = 0;
    let shortScore = 0;

    // Technical direction (highest weight)
    if (scores.technical >= 60) longScore += 3;
    else if (scores.technical <= 40) shortScore += 3;

    // AI/ML prediction
    if (scores.aiMl >= 60) longScore += 2;
    else if (scores.aiMl <= 40) shortScore += 2;

    // Order flow
    if (scores.orderflow >= 60) longScore += 1.5;
    else if (scores.orderflow <= 40) shortScore += 1.5;

    // Liquidation (contrarian)
    if (scores.liquidation >= 60) longScore += 1.5; // Short liquidations = bullish
    else if (scores.liquidation <= 40) shortScore += 1.5; // Long liquidations = bearish

    // Check reasoning for explicit direction mentions
    const allReasons = Object.values(reasons).join(' ').toLowerCase();
    if (allReasons.includes('bullish') || allReasons.includes('oversold')) {
      longScore += 1;
    }
    if (allReasons.includes('bearish') || allReasons.includes('overbought')) {
      shortScore += 1;
    }

    return longScore >= shortScore ? 'long' : 'short';
  }

  /**
   * Calculate stop loss and take profit levels
   */
  private calculatePriceLevels(
    entryPrice: number,
    signalType: 'long' | 'short',
    leverage: number
  ): {
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    takeProfit3: number;
    riskReward: number;
  } {
    // Scale stop based on leverage (higher leverage = tighter stop)
    const baseStopPercent = Math.max(0.5, 2 - leverage / 100);

    // Take profit multipliers
    const tp1Mult = 1.5;
    const tp2Mult = 2.5;
    const tp3Mult = 4.0;

    let stopLoss: number;
    let takeProfit1: number;
    let takeProfit2: number;
    let takeProfit3: number;

    if (signalType === 'long') {
      stopLoss = entryPrice * (1 - baseStopPercent / 100);
      takeProfit1 = entryPrice * (1 + (baseStopPercent * tp1Mult) / 100);
      takeProfit2 = entryPrice * (1 + (baseStopPercent * tp2Mult) / 100);
      takeProfit3 = entryPrice * (1 + (baseStopPercent * tp3Mult) / 100);
    } else {
      stopLoss = entryPrice * (1 + baseStopPercent / 100);
      takeProfit1 = entryPrice * (1 - (baseStopPercent * tp1Mult) / 100);
      takeProfit2 = entryPrice * (1 - (baseStopPercent * tp2Mult) / 100);
      takeProfit3 = entryPrice * (1 - (baseStopPercent * tp3Mult) / 100);
    }

    return {
      stopLoss,
      takeProfit1,
      takeProfit2,
      takeProfit3,
      riskReward: tp1Mult,
    };
  }

  /**
   * Save signal to database
   */
  private async saveSignal(signal: TradingSignal): Promise<TradingSignal | null> {
    if (!supabase) return null;

    try {
      const { data, error } = await supabase
        .from('trading_signals')
        .insert({
          symbol: signal.symbol,
          signal_type: signal.signalType,
          confidence: signal.confidence,
          signal_strength: signal.signalStrength,
          entry_price: signal.entryPrice,
          stop_loss: signal.stopLoss,
          take_profit_1: signal.takeProfit1,
          take_profit_2: signal.takeProfit2,
          take_profit_3: signal.takeProfit3,
          risk_reward_ratio: signal.riskRewardRatio,
          layer_technical: signal.layerScores.technical,
          layer_orderflow: signal.layerScores.orderflow,
          layer_liquidation: signal.layerScores.liquidation,
          layer_sentiment: signal.layerScores.sentiment,
          layer_ai_ml: signal.layerScores.aiMl,
          layer_cosmic: signal.layerScores.cosmic,
          weight_technical: signal.layerWeights.technical,
          weight_orderflow: signal.layerWeights.orderflow,
          weight_liquidation: signal.layerWeights.liquidation,
          weight_sentiment: signal.layerWeights.sentiment,
          weight_ai_ml: signal.layerWeights.aiMl,
          weight_cosmic: signal.layerWeights.cosmic,
          technical_reason: signal.layerReasons.technical,
          orderflow_reason: signal.layerReasons.orderflow,
          liquidation_reason: signal.layerReasons.liquidation,
          sentiment_reason: signal.layerReasons.sentiment,
          ai_ml_reason: signal.layerReasons.aiMl,
          cosmic_reason: signal.layerReasons.cosmic,
          scanner_tier: signal.scannerTier,
          scanner_interval_seconds: signal.scannerIntervalSeconds,
          status: signal.status,
          expires_at: signal.expiresAt.toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        console.error('[SignalGenerator] Error saving signal:', error);
        return null;
      }

      signal.id = data.id;

      // Create alert
      await supabase.from('alerts').insert({
        alert_type: 'signal_generated',
        severity: 'info',
        title: `New ${signal.signalType.toUpperCase()} Signal`,
        message: `${signal.symbol} @ ${signal.entryPrice.toFixed(2)} | Confidence: ${signal.confidence.toFixed(1)}%`,
        symbol: signal.symbol,
        signal_id: data.id,
        voice_alert: true,
        voice_message: `New ${signal.signalType} signal on ${signal.symbol.replace('USDT', '')} at ${signal.entryPrice.toFixed(2)}`,
      });

      console.log(
        `[SignalGenerator] Signal saved: ${signal.symbol} ${signal.signalType} @ ${signal.entryPrice} (${signal.confidence.toFixed(1)}%)`
      );

      return signal;
    } catch (error) {
      console.error('[SignalGenerator] Exception saving signal:', error);
      return null;
    }
  }

  /**
   * Get pending signals
   */
  async getPendingSignals(limit: number = 10): Promise<TradingSignal[]> {
    if (!supabase) return [];

    try {
      const { data, error } = await supabase
        .from('active_signals_view')
        .select('*')
        .limit(limit);

      if (error || !data) return [];

      return data.map((row: any) => ({
        id: row.id,
        symbol: row.symbol,
        signalType: row.signal_type,
        confidence: row.confidence,
        signalStrength: row.signal_strength,
        entryPrice: row.entry_price,
        stopLoss: row.stop_loss,
        takeProfit1: row.take_profit_1,
        scannerTier: row.scanner_tier,
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        status: 'pending',
        layerScores: { technical: 0, orderflow: 0, liquidation: 0, sentiment: 0, aiMl: 0, cosmic: 0 },
        layerWeights: DEFAULT_WEIGHTS,
        layerReasons: {},
        scannerIntervalSeconds: 60,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Update signal status
   */
  async updateSignalStatus(
    signalId: string,
    status: 'approved' | 'rejected' | 'expired' | 'executed',
    executionId?: string
  ): Promise<void> {
    if (!supabase) return;

    await supabase
      .from('trading_signals')
      .update({
        status,
        executed_at: status === 'executed' ? new Date().toISOString() : null,
        execution_id: executionId || null,
      })
      .eq('id', signalId);
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Signal Generator');
  console.log('='.repeat(50));

  const generator = new SignalGenerator('top10');

  // Example signal generation
  const signal = await generator.generateSignal({
    symbol: 'BTCUSDT',
    currentPrice: 95000,
    layerScores: {
      technical: 75,
      orderflow: 65,
      liquidation: 70,
      sentiment: 55,
      aiMl: 72,
      cosmic: 52,
    },
    layerReasons: {
      technical: 'Bullish EMA alignment',
      orderflow: 'Bid imbalance detected',
      liquidation: 'Recent short liquidations',
      sentiment: 'Neutral',
      aiMl: 'Upward prediction',
      cosmic: 'Neutral',
    },
    tier: 'top10',
    accountBalance: 50,
    currentExposure: 0,
    winRate: 0.55,
    avgWinPercent: 2.5,
    avgLossPercent: 1.5,
  });

  if (signal) {
    console.log('Generated signal:', JSON.stringify(signal, null, 2));
  } else {
    console.log('No signal generated (below threshold)');
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export { CONFIDENCE_THRESHOLDS, DEFAULT_WEIGHTS };
