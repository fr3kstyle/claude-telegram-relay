/**
 * BEHEMOTH Base Scanner
 * Shared logic for all scanner tiers
 */

import { createClient } from "@supabase/supabase-js";
import type { ScannerTier, Ticker, TradingSignal, SignalLayerScores, SignalLayerWeights } from "../utils/trading-types";

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

export const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ============================================================
// Base Scanner Class
// ============================================================

export interface ScannerConfig {
  tier: ScannerTier;
  symbols: string[];
  intervalSeconds: number;
  confidenceThreshold: number;
}

export interface ScanResult {
  symbol: string;
  signal: TradingSignal | null;
  error?: string;
  scanTime: Date;
}

export abstract class BaseScanner {
  protected config: ScannerConfig;
  protected isRunning: boolean = false;
  protected scanInterval: Timer | null = null;
  protected lastScanTime: Date | null = null;
  protected scanCount: number = 0;
  protected errorCount: number = 0;

  constructor(config: ScannerConfig) {
    this.config = config;
  }

  /**
   * Start the scanner loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log(`[${this.config.tier}] Scanner already running`);
      return;
    }

    this.isRunning = true;
    console.log(`[${this.config.tier}] Starting scanner for ${this.config.symbols.length} symbols`);
    console.log(`[${this.config.tier}] Interval: ${this.config.intervalSeconds}s, Threshold: ${this.config.confidenceThreshold}%`);

    // Initial scan
    await this.runScan();

    // Schedule periodic scans
    this.scanInterval = setInterval(
      () => this.runScan(),
      this.config.intervalSeconds * 1000
    );

    // Update scanner state
    await this.updateScannerState(true);
  }

  /**
   * Stop the scanner
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    console.log(`[${this.config.tier}] Scanner stopped`);
    await this.updateScannerState(false);
  }

  /**
   * Run a single scan cycle
   */
  async runScan(): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    const scanStart = Date.now();

    console.log(`[${this.config.tier}] Scanning ${this.config.symbols.length} symbols...`);

    for (const symbol of this.config.symbols) {
      try {
        const signal = await this.scanSymbol(symbol);
        results.push({
          symbol,
          signal,
          scanTime: new Date(),
        });
      } catch (error) {
        this.errorCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[${this.config.tier}] Error scanning ${symbol}:`, errorMsg);
        results.push({
          symbol,
          signal: null,
          error: errorMsg,
          scanTime: new Date(),
        });
      }
    }

    this.lastScanTime = new Date();
    this.scanCount++;

    const scanDuration = Date.now() - scanStart;
    const signalsFound = results.filter(r => r.signal !== null).length;

    console.log(
      `[${this.config.tier}] Scan complete: ${signalsFound} signals found in ${scanDuration}ms`
    );

    // Log scan to database
    await this.logScan(results, scanDuration);

    return results;
  }

  /**
   * Scan a single symbol - implemented by subclasses
   */
  protected abstract scanSymbol(symbol: string): Promise<TradingSignal | null>;

  /**
   * Generate signal using MCP tools
   */
  protected async generateSignal(
    symbol: string,
    layerScores: SignalLayerScores,
    layerReasons: Record<string, string>,
    currentPrice: number
  ): Promise<TradingSignal | null> {
    // Default weights
    const weights: SignalLayerWeights = {
      technical: 0.35,
      orderflow: 0.20,
      liquidation: 0.15,
      sentiment: 0.10,
      aiMl: 0.15,
      cosmic: 0.05,
    };

    // Calculate weighted confidence
    const confidence =
      layerScores.technical * weights.technical +
      layerScores.orderflow * weights.orderflow +
      layerScores.liquidation * weights.liquidation +
      layerScores.sentiment * weights.sentiment +
      layerScores.aiMl * weights.aiMl +
      layerScores.cosmic * weights.cosmic;

    // Check threshold
    if (confidence < this.config.confidenceThreshold) {
      console.log(
        `[${this.config.tier}] ${symbol}: Confidence ${confidence.toFixed(1)}% below threshold ${this.config.confidenceThreshold}%`
      );
      return null;
    }

    // Calculate signal strength (average of top 3 layers)
    const sortedScores = Object.values(layerScores).sort((a, b) => b - a);
    const signalStrength = (sortedScores[0] + sortedScores[1] + sortedScores[2]) / 3;

    // Determine signal type based on technical and AI layers
    const signalType = this.determineSignalType(layerScores, layerReasons);

    // Calculate stop loss and take profit levels
    const { stopLoss, takeProfit1, takeProfit2, takeProfit3, riskReward } =
      this.calculateLevels(currentPrice, signalType, confidence);

    const signal: TradingSignal = {
      symbol,
      signalType,
      confidence,
      signalStrength,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      takeProfit3,
      riskRewardRatio: riskReward,
      layerScores,
      layerWeights: weights,
      layerReasons,
      scannerTier: this.config.tier,
      scannerIntervalSeconds: this.config.intervalSeconds,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min expiry
    };

    // Save to database
    await this.saveSignal(signal);

    return signal;
  }

  /**
   * Determine signal type (long/short) from layer scores
   */
  protected determineSignalType(
    scores: SignalLayerScores,
    reasons: Record<string, string>
  ): 'long' | 'short' {
    // Weight technical and AI layers more heavily for direction
    let longScore = 0;
    let shortScore = 0;

    // Technical direction
    if (reasons.technical?.toLowerCase().includes('bullish')) longScore += 2;
    if (reasons.technical?.toLowerCase().includes('bearish')) shortScore += 2;

    // AI/ML prediction
    if (reasons.aiMl?.toLowerCase().includes('up')) longScore += 2;
    if (reasons.aiMl?.toLowerCase().includes('down')) shortScore += 2;

    // Order flow
    if (reasons.orderflow?.toLowerCase().includes('buy')) longScore += 1;
    if (reasons.orderflow?.toLowerCase().includes('sell')) shortScore += 1;

    // Liquidation cascades (contrarian)
    if (reasons.liquidation?.toLowerCase().includes('short')) longScore += 1.5;
    if (reasons.liquidation?.toLowerCase().includes('long')) shortScore += 1.5;

    return longScore >= shortScore ? 'long' : 'short';
  }

  /**
   * Calculate stop loss and take profit levels
   */
  protected calculateLevels(
    entryPrice: number,
    signalType: 'long' | 'short',
    confidence: number
  ): {
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    takeProfit3: number;
    riskReward: number;
  } {
    // Base stop loss at 1.5% for more breathing room
    const stopLossPercent = 1.5;
    // Scale take profits based on confidence
    const tp1Multiplier = 1.5;
    const tp2Multiplier = 2.5;
    const tp3Multiplier = 4.0;

    let stopLoss: number;
    let takeProfit1: number;
    let takeProfit2: number;
    let takeProfit3: number;

    if (signalType === 'long') {
      stopLoss = entryPrice * (1 - stopLossPercent / 100);
      takeProfit1 = entryPrice * (1 + (stopLossPercent * tp1Multiplier) / 100);
      takeProfit2 = entryPrice * (1 + (stopLossPercent * tp2Multiplier) / 100);
      takeProfit3 = entryPrice * (1 + (stopLossPercent * tp3Multiplier) / 100);
    } else {
      stopLoss = entryPrice * (1 + stopLossPercent / 100);
      takeProfit1 = entryPrice * (1 - (stopLossPercent * tp1Multiplier) / 100);
      takeProfit2 = entryPrice * (1 - (stopLossPercent * tp2Multiplier) / 100);
      takeProfit3 = entryPrice * (1 - (stopLossPercent * tp3Multiplier) / 100);
    }

    const riskReward = tp1Multiplier; // 1.5:1 at TP1

    return { stopLoss, takeProfit1, takeProfit2, takeProfit3, riskReward };
  }

  /**
   * Save signal to database
   */
  protected async saveSignal(signal: TradingSignal): Promise<void> {
    if (!supabase) return;

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
        console.error(`[${this.config.tier}] Error saving signal:`, error);
      } else {
        console.log(`[${this.config.tier}] Signal saved: ${signal.symbol} ${signal.signalType} @ ${signal.entryPrice}`);
      }
    } catch (error) {
      console.error(`[${this.config.tier}] Exception saving signal:`, error);
    }
  }

  /**
   * Log scan to database
   */
  protected async logScan(results: ScanResult[], duration: number): Promise<void> {
    if (!supabase) return;

    try {
      const signalsFound = results.filter(r => r.signal !== null).length;
      const errors = results.filter(r => r.error).length;

      await supabase.rpc('update_scanner_state', {
        p_tier: this.config.tier,
        p_scan: true,
        p_signal: signalsFound > 0,
        p_error: errors > 0 ? `${errors} errors in scan` : null,
      });

      // Log to system events
      await supabase.from('system_events').insert({
        event_type: 'scanner_scan',
        event_category: 'scanner',
        severity: 'info',
        message: `${this.config.tier} scan complete: ${signalsFound} signals, ${errors} errors`,
        scanner_tier: this.config.tier,
        metadata: {
          symbols_scanned: this.config.symbols.length,
          signals_found: signalsFound,
          errors: errors,
          duration_ms: duration,
        },
      });
    } catch (error) {
      console.error(`[${this.config.tier}] Error logging scan:`, error);
    }
  }

  /**
   * Update scanner state in database
   */
  protected async updateScannerState(isActive: boolean): Promise<void> {
    if (!supabase) return;

    try {
      await supabase
        .from('scanner_state')
        .update({
          is_active: isActive,
          current_symbols: this.config.symbols,
          updated_at: new Date().toISOString(),
        })
        .eq('scanner_tier', this.config.tier);
    } catch (error) {
      console.error(`[${this.config.tier}] Error updating scanner state:`, error);
    }
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    tier: ScannerTier;
    isRunning: boolean;
    scanCount: number;
    errorCount: number;
    lastScanTime: Date | null;
    symbolsCount: number;
  } {
    return {
      tier: this.config.tier,
      isRunning: this.isRunning,
      scanCount: this.scanCount,
      errorCount: this.errorCount,
      lastScanTime: this.lastScanTime,
      symbolsCount: this.config.symbols.length,
    };
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Get scanner configuration from database
 */
export async function getScannerConfig(tier: ScannerTier): Promise<ScannerConfig> {
  const defaults: Record<ScannerTier, ScannerConfig> = {
    top10: {
      tier: 'top10',
      symbols: ['RPLUSDT', 'INITUSDT', 'POWERUSDT', 'SPACEUSDT', 'ARIAUSDT'],
      intervalSeconds: 60,
      confidenceThreshold: 70,
    },
    top20: {
      tier: 'top20',
      symbols: ['ORCAUSDT', 'IRYSUSDT', 'USELESSUSDT', 'OGNUSDT', 'FHEUSDT', 'JELLYJELLYUSDT', 'XNYUSDT'],
      intervalSeconds: 120,
      confidenceThreshold: 70,
    },
    top50: {
      tier: 'top50',
      symbols: ['MOODENGUSDT', 'FIGHTUSDT', 'DEEPUSDT', 'MAGICUSDT', 'TRIAUSDT', 'CLOUSDT', 'MERLUSDT', 'ESPUSDT', 'TNSRUSDT', 'UMAUSDT'],
      intervalSeconds: 300,
      confidenceThreshold: 70,
    },
  };

  if (!supabase) return defaults[tier];

  try {
    const { data } = await supabase
      .from('trading_config')
      .select('config_value')
      .eq('config_key', `scanner.${tier}.symbols`)
      .single();

    if (data?.config_value) {
      defaults[tier].symbols = data.config_value as string[];
    }

    const { data: intervalData } = await supabase
      .from('trading_config')
      .select('config_value')
      .eq('config_key', `scanner.${tier}.interval_seconds`)
      .single();

    if (intervalData?.config_value) {
      defaults[tier].intervalSeconds = intervalData.config_value as number;
    }

    const { data: thresholdData } = await supabase
      .from('trading_config')
      .select('config_value')
      .eq('config_key', `signal.confidence_threshold.${tier}`)
      .single();

    if (thresholdData?.config_value) {
      defaults[tier].confidenceThreshold = thresholdData.config_value as number;
    }
  } catch (error) {
    console.log(`[${tier}] Using default config (database unavailable)`);
  }

  return defaults[tier];
}
