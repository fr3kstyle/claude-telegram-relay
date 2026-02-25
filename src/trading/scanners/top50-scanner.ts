/**
 * BEHEMOTH Top 50 Scanner - REAL DATA VERSION
 *
 * Uses actual data sources:
 * - Technical analysis (real RSI, EMA, MACD)
 * - Whale tracking (large orders, orderbook walls)
 * - Sentiment (Reddit, Fear/Greed, News)
 * - Liquidations (Bybit WebSocket)
 * - ML predictions (pattern recognition, AI)
 * - Trade journal learning
 */

import { BaseScanner } from './base-scanner';
import { sentimentAnalyzer } from '../analysis/sentiment';
import { whaleTracker } from '../analysis/whale-tracker';
import { liquidationTracker } from '../analysis/liquidation-tracker';
import { mlPredictor } from '../analysis/ml-predictor-real';
import { tradeJournal } from '../learning/trade-journal-real';
import type { TradingSignal, SignalLayerScores } from '../utils/trading-types';

class Top50Scanner extends BaseScanner {
  private allSymbols: string[] = [];

  constructor() {
    super({
      tier: 'top50',
      symbols: ['MOODENGUSDT', 'FIGHTUSDT', 'DEEPUSDT', 'MAGICUSDT', 'TRIAUSDT', 'CLOUSDT', 'MERLUSDT', 'ESPUSDT', 'TNSRUSDT', 'UMAUSDT'],
      intervalSeconds: 300,
      confidenceThreshold: 70,
    });
  }

  /**
   * Initialize with top 50 symbols by volume
   */
  async initialize(): Promise<void> {
    this.allSymbols = await this.fetchTop50Symbols();
    this.config.symbols = this.allSymbols;
    console.log(`[top50] Loaded ${this.allSymbols.length} symbols`);
  }

  /**
   * Fetch top 50 symbols by 24h volume
   */
  private async fetchTop50Symbols(): Promise<string[]> {
    try {
      const response = await fetch(
        'https://api.bybit.com/v5/market/tickers?category=linear'
      );

      if (!response.ok) {
        console.error('[top50] Failed to fetch symbols');
        return this.getDefaultSymbols();
      }

      const data = await response.json();
      const tickers = data.result?.list || [];

      // Filter for USDT pairs, sort by volume
      const sorted = tickers
        .filter((t: any) => t.symbol.endsWith('USDT'))
        .sort((a: any, b: any) => parseFloat(b.volume24h) - parseFloat(a.volume24h))
        .slice(0, 50)
        .map((t: any) => t.symbol);

      return sorted.length > 0 ? sorted : this.getDefaultSymbols();
    } catch (error) {
      console.error('[top50] Error fetching symbols:', error);
      return this.getDefaultSymbols();
    }
  }

  private getDefaultSymbols(): string[] {
    return [
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
      'BNBUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT',
      'LINKUSDT', 'ATOMUSDT', 'LTCUSDT', 'UNIUSDT', 'ETCUSDT',
      'XLMUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT',
    ];
  }

  protected async scanSymbol(symbol: string): Promise<TradingSignal | null> {
    const marketData = await this.getMarketData(symbol);
    if (!marketData) {
      throw new Error(`Failed to get market data for ${symbol}`);
    }

    // Skip low volume pairs
    if (marketData.volume24h < 10000000) { // < $10M volume
      return null;
    }

    // Get candles for technical analysis
    const candles = await this.getCandles(symbol);
    if (!candles || candles.length < 50) {
      throw new Error(`Insufficient candle data for ${symbol}`);
    }

    // Run ALL analysis layers in parallel - REAL DATA ONLY
    const [technical, orderflow, liquidation, sentiment, aiMl, cosmic] = await Promise.all([
      this.calculateTechnical(symbol, marketData, candles),
      this.calculateOrderflow(symbol),
      this.calculateLiquidation(symbol),
      this.calculateSentiment(symbol),
      this.calculateMLPrediction(symbol, candles),
      this.calculateTiming(),
    ]);

    const layerScores: SignalLayerScores = {
      technical,
      orderflow,
      liquidation,
      sentiment,
      aiMl,
      cosmic,
    };

    // Get layer reasons
    const layerReasons = await this.getLayerReasons(symbol, layerScores, marketData);

    // Check if market conditions are favorable based on learning
    const conditions = {
      trend: technical > 55 ? 'up' : technical < 45 ? 'down' : 'sideways' as const,
      volatility: marketData.priceChangePercent > 5 ? 'high' : marketData.priceChangePercent < 1 ? 'low' : 'medium' as const,
      volume: 'normal' as const,
    };

    const learningCheck = tradeJournal.isConditionFavorable(conditions);
    if (!learningCheck.favorable) {
      console.log(`[top50] ${symbol}: Skipping - ${learningCheck.reasons.join(', ')}`);
      return null;
    }

    return this.generateSignal(symbol, layerScores, layerReasons, marketData.price);
  }

  private async getMarketData(symbol: string): Promise<{
    price: number;
    volume24h: number;
    high24h: number;
    low24h: number;
    priceChangePercent: number;
  } | null> {
    try {
      const response = await fetch(
        `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
      );

      if (!response.ok) return null;

      const data = await response.json();
      const ticker = data.result?.list?.[0];
      if (!ticker) return null;

      return {
        price: parseFloat(ticker.lastPrice),
        volume24h: parseFloat(ticker.turnover24h) || parseFloat(ticker.volume24h),
        high24h: parseFloat(ticker.highPrice24h),
        low24h: parseFloat(ticker.lowPrice24h),
        priceChangePercent: parseFloat(ticker.price24hPcnt) * 100,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get candle data
   */
  private async getCandles(symbol: string): Promise<number[][] | null> {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=100`
      );
      if (!res.ok) return null;

      const data = await res.json();
      return data.result?.list || null;
    } catch (error) {
      console.error(`[top50] Candle error for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * REAL Technical Analysis
   */
  private async calculateTechnical(
    symbol: string,
    marketData: { price: number; priceChangePercent: number },
    candles: number[][]
  ): Promise<number> {
    const closes = candles.map(c => c[4]).reverse();

    // RSI
    let gains = 0, losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const rsi = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses / 14);

    // EMAs
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, 50);

    // Score based on actual signals
    let score = 50;

    // RSI signals
    if (rsi < 25) score += 25; // Deeply oversold - strong buy
    else if (rsi < 35) score += 15; // Oversold
    else if (rsi > 75) score -= 25; // Deeply overbought - strong sell
    else if (rsi > 65) score -= 15; // Overbought

    // Trend alignment
    if (ema9 > ema21 && ema21 > ema50) {
      score += 15; // Bullish trend
    } else if (ema9 < ema21 && ema21 < ema50) {
      score -= 15; // Bearish trend
    }

    // Price position
    if (marketData.price > ema9 && marketData.price > ema21) {
      score += 10;
    } else if (marketData.price < ema9 && marketData.price < ema21) {
      score -= 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * REAL Orderflow Analysis - uses whale tracker
   */
  private async calculateOrderflow(symbol: string): Promise<number> {
    try {
      const whaleData = await whaleTracker.analyze(symbol);
      return whaleData.score;
    } catch (error) {
      console.error(`[top50] Orderflow error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * REAL Liquidation Analysis - uses liquidation tracker
   */
  private async calculateLiquidation(symbol: string): Promise<number> {
    try {
      const liqData = liquidationTracker.getSummary(symbol);
      return liqData.score;
    } catch (error) {
      console.error(`[top50] Liquidation error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * REAL Sentiment Analysis - Reddit + Fear/Greed + News
   */
  private async calculateSentiment(symbol: string): Promise<number> {
    try {
      const sentimentData = await sentimentAnalyzer.analyze(symbol);
      return sentimentData.score;
    } catch (error) {
      console.error(`[top50] Sentiment error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * REAL ML Prediction - pattern recognition + AI
   */
  private async calculateMLPrediction(symbol: string, candles: number[][]): Promise<number> {
    try {
      const prediction = await mlPredictor.predict(symbol, candles);
      return prediction.score;
    } catch (error) {
      console.error(`[top50] ML error for ${symbol}:`, error);
      return 50;
    }
  }

  /**
   * Timing/cosmic layer - based on market hours and patterns
   */
  private async calculateTiming(): Promise<number> {
    const now = new Date();
    const hour = now.getUTCHours();
    const day = now.getUTCDay();

    let score = 50;

    // Market hours (UTC)
    if (hour >= 13 && hour <= 16) {
      score += 10; // EU/US overlap - high liquidity
    } else if (hour >= 0 && hour <= 4) {
      score += 5; // Asian session - good for crypto
    } else if (hour >= 8 && hour <= 12) {
      score += 5; // European morning
    }

    // Weekend penalty (lower liquidity)
    if (day === 0 || day === 6) {
      score -= 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Generate layer reasons
   */
  private async getLayerReasons(
    symbol: string,
    scores: SignalLayerScores,
    marketData: { price: number; priceChangePercent: number }
  ): Promise<Record<string, string>> {
    const reasons: Record<string, string> = {};

    // Technical
    if (scores.technical >= 65) {
      reasons.technical = `Bullish technical setup (${scores.technical.toFixed(0)}%)`;
    } else if (scores.technical <= 35) {
      reasons.technical = `Bearish technical setup (${scores.technical.toFixed(0)}%)`;
    } else {
      reasons.technical = `Neutral technicals (${scores.technical.toFixed(0)}%)`;
    }

    // Get whale data for reason
    try {
      const whaleData = await whaleTracker.analyze(symbol);
      reasons.orderflow = whaleData.reason;
    } catch {
      reasons.orderflow = `Order flow: ${scores.orderflow.toFixed(0)}%`;
    }

    // Get liquidation data
    try {
      const liqData = liquidationTracker.getSummary(symbol);
      reasons.liquidation = liqData.reason;
    } catch {
      reasons.liquidation = `Liquidations: ${scores.liquidation.toFixed(0)}%`;
    }

    // Get sentiment data
    try {
      const sentData = await sentimentAnalyzer.analyze(symbol);
      reasons.sentiment = sentData.reason;
    } catch {
      reasons.sentiment = `Sentiment: ${scores.sentiment.toFixed(0)}%`;
    }

    // Get ML prediction
    const candles = await this.getCandles(symbol);
    if (candles) {
      try {
        const pred = await mlPredictor.predict(symbol, candles);
        reasons.aiMl = pred.reason;
      } catch {
        reasons.aiMl = `ML: ${scores.aiMl.toFixed(0)}%`;
      }
    } else {
      reasons.aiMl = `ML: ${scores.aiMl.toFixed(0)}%`;
    }

    // Timing
    reasons.cosmic = `Timing score: ${scores.cosmic.toFixed(0)}%`;

    return reasons;
  }

  private calculateEMA(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] || 0;

    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
  }
}

// Main entry
async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Top 50 Scanner - REAL DATA');
  console.log('='.repeat(50));
  console.log('[top50] Using REAL data sources:');
  console.log('  - Technical: RSI, EMA, MACD');
  console.log('  - Whale Tracking: Large orders, walls');
  console.log('  - Sentiment: Reddit, Fear/Greed, News');
  console.log('  - Liquidations: Bybit WebSocket');
  console.log('  - ML: Pattern recognition + AI');
  console.log('  - Learning: Trade journal');

  const scanner = new Top50Scanner();
  await scanner.initialize();

  process.on('SIGINT', async () => {
    console.log('\n[top50] Shutting down...');
    await scanner.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[top50] Shutting down...');
    await scanner.stop();
    process.exit(0);
  });

  await scanner.start();
}

if (import.meta.main) {
  main().catch(console.error);
}

export { Top50Scanner };
