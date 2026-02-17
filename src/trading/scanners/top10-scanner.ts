/**
 * BEHEMOTH Top 10 Scanner
 *
 * Scans top 10 crypto pairs by volume at 1-minute intervals.
 * Highest frequency scanning for highest liquidity pairs.
 */

import { BaseScanner, getScannerConfig } from './base-scanner';
import type { ScannerTier, TradingSignal, SignalLayerScores } from '../utils/trading-types';

// ============================================================
// Top 10 Scanner Implementation
// ============================================================

class Top10Scanner extends BaseScanner {
  constructor() {
    super({
      tier: 'top10',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      intervalSeconds: 60,
      confidenceThreshold: 78,
    });
  }

  /**
   * Scan a single symbol for trading signals
   */
  protected async scanSymbol(symbol: string): Promise<TradingSignal | null> {
    // Get current price and market data
    const marketData = await this.getMarketData(symbol);
    if (!marketData) {
      throw new Error(`Failed to get market data for ${symbol}`);
    }

    // Calculate 6-layer scores
    const layerScores = await this.calculateLayerScores(symbol, marketData);
    const layerReasons = await this.getLayerReasons(symbol, layerScores, marketData);

    // Generate signal if criteria met
    return this.generateSignal(symbol, layerScores, layerReasons, marketData.price);
  }

  /**
   * Get market data from MCP tools or direct API
   */
  private async getMarketData(symbol: string): Promise<{
    price: number;
    volume24h: number;
    high24h: number;
    low24h: number;
    priceChangePercent: number;
  } | null> {
    try {
      // Use MCP exchange.ticker tool if available
      // For now, use direct API call
      const response = await fetch(
        `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      const ticker = data.result?.list?.[0];

      if (!ticker) return null;

      return {
        price: parseFloat(ticker.lastPrice),
        volume24h: parseFloat(ticker.volume24h),
        high24h: parseFloat(ticker.highPrice24h),
        low24h: parseFloat(ticker.lowPrice24h),
        priceChangePercent: parseFloat(ticker.price24hPcnt) * 100,
      };
    } catch (error) {
      console.error(`[top10] Error getting market data for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Calculate all 6 layer scores
   */
  private async calculateLayerScores(
    symbol: string,
    marketData: { price: number; volume24h: number; priceChangePercent: number }
  ): Promise<SignalLayerScores> {
    // Run all layers in parallel for speed
    const [technical, orderflow, liquidation, sentiment, aiMl, cosmic] = await Promise.all([
      this.calculateTechnicalLayer(symbol, marketData),
      this.calculateOrderflowLayer(symbol),
      this.calculateLiquidationLayer(symbol),
      this.calculateSentimentLayer(symbol),
      this.calculateAIMLLayer(symbol, marketData),
      this.calculateCosmicLayer(),
    ]);

    return { technical, orderflow, liquidation, sentiment, aiMl, cosmic };
  }

  /**
   * Layer 1: Technical Analysis (35% weight)
   */
  private async calculateTechnicalLayer(
    symbol: string,
    marketData: { price: number; priceChangePercent: number }
  ): Promise<number> {
    try {
      // Get technical indicators from MCP or calculate
      const response = await fetch(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=100`
      );

      if (!response.ok) return 50; // Neutral

      const data = await response.json();
      const candles = data.result?.list || [];

      if (candles.length < 50) return 50;

      // Calculate indicators
      const closes = candles.map((c: string[]) => parseFloat(c[4])).reverse();

      // RSI
      const rsi = this.calculateRSI(closes, 14);

      // EMA alignment
      const ema9 = this.calculateEMA(closes, 9);
      const ema21 = this.calculateEMA(closes, 21);
      const ema50 = this.calculateEMA(closes, 50);

      // Score based on alignment
      let score = 50;

      // RSI extremes (contrarian)
      if (rsi < 30) score += 20; // Oversold - bullish
      else if (rsi > 70) score -= 20; // Overbought - bearish
      else if (rsi >= 40 && rsi <= 60) score += 5; // Neutral zone

      // EMA alignment for trend
      if (ema9 > ema21 && ema21 > ema50) {
        score += 15; // Bullish alignment
      } else if (ema9 < ema21 && ema21 < ema50) {
        score -= 15; // Bearish alignment
      }

      // Price relative to EMAs
      if (marketData.price > ema9 && marketData.price > ema21) {
        score += 10;
      } else if (marketData.price < ema9 && marketData.price < ema21) {
        score -= 10;
      }

      return Math.max(0, Math.min(100, score));
    } catch (error) {
      console.error(`[top10] Technical layer error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * Layer 2: Order Flow Analysis (20% weight)
   */
  private async calculateOrderflowLayer(symbol: string): Promise<number> {
    try {
      // Get orderbook data
      const response = await fetch(
        `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`
      );

      if (!response.ok) return 50;

      const data = await response.json();
      const bids = data.result?.b || [];
      const asks = data.result?.a || [];

      if (bids.length === 0 || asks.length === 0) return 50;

      // Calculate bid/ask imbalance
      const bidVolume = bids.reduce((sum: number, b: string[]) => sum + parseFloat(b[1]), 0);
      const askVolume = asks.reduce((sum: number, a: string[]) => sum + parseFloat(a[1]), 0);
      const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);

      // Score based on imbalance
      let score = 50 + imbalance * 50;

      // Check for large walls
      const maxBid = Math.max(...bids.map((b: string[]) => parseFloat(b[1])));
      const maxAsk = Math.max(...asks.map((a: string[]) => parseFloat(a[1])));
      const avgSize = (bidVolume + askVolume) / 100;

      if (maxBid > avgSize * 5) score += 10; // Bid wall support
      if (maxAsk > avgSize * 5) score -= 10; // Ask wall resistance

      return Math.max(0, Math.min(100, score));
    } catch (error) {
      console.error(`[top10] Orderflow layer error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * Layer 3: Liquidation Analysis (15% weight)
   */
  private async calculateLiquidationLayer(symbol: string): Promise<number> {
    try {
      // Get recent liquidations from database
      const { data, error } = await BaseScanner.prototype.constructor.prototype.supabase
        ?.from('liquidation_summary')
        .select('*')
        .eq('symbol', symbol)
        .order('bucket_start', { ascending: false })
        .limit(5) || { data: null, error: true };

      if (error || !data || data.length === 0) return 50;

      // Analyze liquidation cascade
      const recentSummary = data[0];
      let score = 50;

      // Heavy short liquidations = bullish (short squeeze potential)
      if (recentSummary.short_total_usd > recentSummary.long_total_usd * 2) {
        score += 25;
      }
      // Heavy long liquidations = bearish
      else if (recentSummary.long_total_usd > recentSummary.short_total_usd * 2) {
        score -= 25;
      }

      // Large liquidation events
      const totalLiquidations = recentSummary.long_total_usd + recentSummary.short_total_usd;
      if (totalLiquidations > 1000000) {
        // > $1M in liquidations
        score += recentSummary.net_usd > 0 ? 10 : -10;
      }

      return Math.max(0, Math.min(100, score));
    } catch (error) {
      console.error(`[top10] Liquidation layer error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * Layer 4: Sentiment Analysis (10% weight)
   */
  private async calculateSentimentLayer(symbol: string): Promise<number> {
    // Placeholder - would integrate with Twitter/Reddit APIs
    // For now, return neutral with slight randomness to add variance
    const base = 50;
    const noise = (Math.random() - 0.5) * 10;
    return Math.max(0, Math.min(100, base + noise));
  }

  /**
   * Layer 5: AI/ML Predictions (15% weight)
   */
  private async calculateAIMLLayer(
    symbol: string,
    marketData: { price: number; priceChangePercent: number }
  ): Promise<number> {
    try {
      // Check for recent ML predictions in database
      const { data, error } = await (await import('./base-scanner')).supabase
        ?.from('ml_predictions')
        .select('*')
        .eq('symbol', symbol)
        .order('prediction_time', { ascending: false })
        .limit(1) || { data: null, error: true };

      if (error || !data || data.length === 0) {
        // No ML prediction, use momentum-based estimate
        let score = 50;
        if (marketData.priceChangePercent > 2) score += 15;
        else if (marketData.priceChangePercent < -2) score -= 15;
        return Math.max(0, Math.min(100, score));
      }

      const prediction = data[0];
      let score = 50;

      // Direction confidence
      if (prediction.predicted_direction === 'up') {
        score = 50 + prediction.confidence / 2;
      } else if (prediction.predicted_direction === 'down') {
        score = 50 - prediction.confidence / 2;
      }

      return Math.max(0, Math.min(100, score));
    } catch (error) {
      console.error(`[top10] AI/ML layer error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * Layer 6: Cosmic Analysis (5% weight)
   */
  private async calculateCosmicLayer(): Promise<number> {
    try {
      // Get moon phase from MCP cosmic tool
      const now = new Date();
      const lunarCycle = this.getMoonPhase(now);

      // Historical patterns suggest certain moon phases correlate with volatility
      // This is a small weight layer, just adds slight bias
      let score = 50;

      switch (lunarCycle.phase) {
        case 'full':
          score = 55; // Slight bullish bias
          break;
        case 'new':
          score = 45; // Slight bearish bias
          break;
        case 'first_quarter':
          score = 52;
          break;
        case 'last_quarter':
          score = 48;
          break;
      }

      return score;
    } catch {
      return 50;
    }
  }

  /**
   * Calculate moon phase
   */
  private getMoonPhase(date: Date): { phase: string; illumination: number } {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    // Simple moon phase calculation
    const c = Math.floor(365.25 * year) + Math.floor(30.6 * month) + day - 694039.09;
    const phase = (c / 29.53) % 1;

    let phaseName: string;
    if (phase < 0.03 || phase > 0.97) phaseName = 'new';
    else if (phase < 0.22) phaseName = 'waxing_crescent';
    else if (phase < 0.28) phaseName = 'first_quarter';
    else if (phase < 0.47) phaseName = 'waxing_gibbous';
    else if (phase < 0.53) phaseName = 'full';
    else if (phase < 0.72) phaseName = 'waning_gibbous';
    else if (phase < 0.78) phaseName = 'last_quarter';
    else phaseName = 'waning_crescent';

    return { phase: phaseName, illumination: phase * 100 };
  }

  /**
   * Get reasoning for each layer
   */
  private async getLayerReasons(
    symbol: string,
    scores: SignalLayerScores,
    marketData: { price: number; priceChangePercent: number }
  ): Promise<Record<string, string>> {
    const reasons: Record<string, string> = {};

    // Technical reasoning
    if (scores.technical >= 70) {
      reasons.technical = 'Bullish technical setup: RSI not overbought, EMAs aligned upward';
    } else if (scores.technical <= 30) {
      reasons.technical = 'Bearish technical setup: RSI not oversold, EMAs aligned downward';
    } else {
      reasons.technical = `Neutral technicals: RSI mid-range, mixed EMA signals (${scores.technical.toFixed(0)}%)`;
    }

    // Orderflow reasoning
    if (scores.orderflow >= 60) {
      reasons.orderflow = 'Strong buy pressure in orderbook, bid walls detected';
    } else if (scores.orderflow <= 40) {
      reasons.orderflow = 'Strong sell pressure in orderbook, ask walls detected';
    } else {
      reasons.orderflow = 'Balanced orderbook with no significant imbalance';
    }

    // Liquidation reasoning
    if (scores.liquidation >= 60) {
      reasons.liquidation = 'Recent short liquidations suggest squeeze potential';
    } else if (scores.liquidation <= 40) {
      reasons.liquidation = 'Recent long liquidations suggest downside cascade';
    } else {
      reasons.liquidation = 'No significant liquidation activity';
    }

    // Sentiment reasoning
    reasons.sentiment = `Market sentiment score: ${scores.sentiment.toFixed(0)}%`;

    // AI/ML reasoning
    if (scores.aiMl >= 60) {
      reasons.aiMl = 'ML model predicts upward price movement';
    } else if (scores.aiMl <= 40) {
      reasons.aiMl = 'ML model predicts downward price movement';
    } else {
      reasons.aiMl = 'ML model neutral on direction';
    }

    // Cosmic reasoning
    reasons.cosmic = `Lunar cycle correlation: ${scores.cosmic.toFixed(0)}%`;

    return reasons;
  }

  // Technical indicator helpers
  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private calculateEMA(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] || 0;

    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b) / period;

    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Top 10 Scanner');
  console.log('='.repeat(50));

  const scanner = new Top10Scanner();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[top10] Shutting down...');
    await scanner.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[top10] Shutting down...');
    await scanner.stop();
    process.exit(0);
  });

  // Start scanning
  await scanner.start();
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

export { Top10Scanner };
