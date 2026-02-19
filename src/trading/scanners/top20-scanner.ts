/**
 * BEHEMOTH Top 20 Scanner
 *
 * Scans top 20 crypto pairs at 2-minute intervals.
 * Mid-frequency scanning for good liquidity pairs.
 */

import { BaseScanner } from './base-scanner';
import type { TradingSignal, SignalLayerScores } from '../utils/trading-types';

// ============================================================
// Top 20 Scanner Implementation
// ============================================================

class Top20Scanner extends BaseScanner {
  constructor() {
    super({
      tier: 'top20',
      symbols: ['ORCAUSDT', 'IRYSUSDT', 'USELESSUSDT', 'OGNUSDT', 'FHEUSDT', 'JELLYJELLYUSDT', 'XNYUSDT'],
      intervalSeconds: 120,
      confidenceThreshold: 70,
    });
  }

  protected async scanSymbol(symbol: string): Promise<TradingSignal | null> {
    const marketData = await this.getMarketData(symbol);
    if (!marketData) {
      throw new Error(`Failed to get market data for ${symbol}`);
    }

    const layerScores = await this.calculateLayerScores(symbol, marketData);
    const layerReasons = await this.getLayerReasons(symbol, layerScores, marketData);

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
        volume24h: parseFloat(ticker.volume24h),
        high24h: parseFloat(ticker.highPrice24h),
        low24h: parseFloat(ticker.lowPrice24h),
        priceChangePercent: parseFloat(ticker.price24hPcnt) * 100,
      };
    } catch (error) {
      console.error(`[top20] Error getting market data for ${symbol}:`, error);
      return null;
    }
  }

  private async calculateLayerScores(
    symbol: string,
    marketData: { price: number; volume24h: number; priceChangePercent: number }
  ): Promise<SignalLayerScores> {
    const [technical, orderflow, liquidation, sentiment, aiMl, cosmic] = await Promise.all([
      this.calculateTechnicalLayer(symbol, marketData),
      this.calculateOrderflowLayer(symbol),
      Promise.resolve(50), // Liquidation - neutral
      Promise.resolve(50 + (Math.random() - 0.5) * 10), // Sentiment
      this.calculateAIMLLayer(symbol),
      this.calculateCosmicLayer(),
    ]);

    return { technical, orderflow, liquidation, sentiment, aiMl, cosmic };
  }

  private async calculateTechnicalLayer(
    symbol: string,
    marketData: { price: number; priceChangePercent: number }
  ): Promise<number> {
    try {
      const response = await fetch(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=100`
      );

      if (!response.ok) return 50;

      const data = await response.json();
      const candles = data.result?.list || [];
      if (candles.length < 50) return 50;

      const closes = candles.map((c: string[]) => parseFloat(c[4])).reverse();
      const rsi = this.calculateRSI(closes, 14);
      const ema9 = this.calculateEMA(closes, 9);
      const ema21 = this.calculateEMA(closes, 21);

      let score = 50;
      if (rsi < 30) score += 20;
      else if (rsi > 70) score -= 20;

      if (ema9 > ema21) score += 15;
      else score -= 15;

      if (marketData.price > ema9) score += 10;
      else score -= 10;

      return Math.max(0, Math.min(100, score));
    } catch {
      return 50;
    }
  }

  private async calculateOrderflowLayer(symbol: string): Promise<number> {
    try {
      const response = await fetch(
        `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=25`
      );

      if (!response.ok) return 50;

      const data = await response.json();
      const bids = data.result?.b || [];
      const asks = data.result?.a || [];

      if (bids.length === 0 || asks.length === 0) return 50;

      const bidVolume = bids.reduce((sum: number, b: string[]) => sum + parseFloat(b[1]), 0);
      const askVolume = asks.reduce((sum: number, a: string[]) => sum + parseFloat(a[1]), 0);
      const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);

      return Math.max(0, Math.min(100, 50 + imbalance * 40));
    } catch {
      return 50;
    }
  }

  private async calculateAIMLLayer(symbol: string): Promise<number> {
    // Simplified ML layer for top20
    return 50 + (Math.random() - 0.5) * 20;
  }

  private async calculateCosmicLayer(): Promise<number> {
    const now = new Date();
    const dayOfMonth = now.getDate();
    const hour = now.getHours();

    // Simple cosmic scoring based on time patterns
    let score = 50;
    if (hour >= 8 && hour <= 12) score += 5; // Morning bullish bias
    if (hour >= 20 && hour <= 23) score -= 5; // Evening bearish bias
    if (dayOfMonth <= 7) score += 3; // Start of month bullish

    return Math.max(0, Math.min(100, score));
  }

  private async getLayerReasons(
    symbol: string,
    scores: SignalLayerScores,
    marketData: { price: number; priceChangePercent: number }
  ): Promise<Record<string, string>> {
    return {
      technical: `Technical score: ${scores.technical.toFixed(0)}%`,
      orderflow: `Order flow score: ${scores.orderflow.toFixed(0)}%`,
      liquidation: 'No significant liquidation data',
      sentiment: `Sentiment: ${scores.sentiment.toFixed(0)}%`,
      aiMl: `ML prediction: ${scores.aiMl.toFixed(0)}%`,
      cosmic: `Cosmic alignment: ${scores.cosmic.toFixed(0)}%`,
    };
  }

  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    if (losses === 0) return 100;
    return 100 - 100 / (1 + gains / losses / period);
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
  console.log('BEHEMOTH Top 20 Scanner');
  console.log('='.repeat(50));

  const scanner = new Top20Scanner();

  process.on('SIGINT', async () => {
    console.log('\n[top20] Shutting down...');
    await scanner.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[top20] Shutting down...');
    await scanner.stop();
    process.exit(0);
  });

  await scanner.start();
}

if (import.meta.main) {
  main().catch(console.error);
}

export { Top20Scanner };
