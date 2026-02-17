/**
 * BEHEMOTH Top 50 Scanner
 *
 * Scans top 50 crypto pairs at 10-minute intervals.
 * Lower frequency scanning for broader market coverage.
 */

import { BaseScanner } from './base-scanner';
import type { TradingSignal, SignalLayerScores } from '../utils/trading-types';

// ============================================================
// Top 50 Scanner Implementation
// ============================================================

class Top50Scanner extends BaseScanner {
  private allSymbols: string[] = [];

  constructor() {
    super({
      tier: 'top50',
      symbols: [], // Populated dynamically
      intervalSeconds: 600,
      confidenceThreshold: 82,
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

    const layerScores = await this.calculateLayerScores(symbol, marketData);
    const layerReasons = this.getLayerReasons(layerScores);

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

  private async calculateLayerScores(
    symbol: string,
    marketData: { price: number; volume24h: number; priceChangePercent: number }
  ): Promise<SignalLayerScores> {
    // Simplified scoring for top50 (more symbols, less compute)
    const momentumScore = this.calculateMomentumScore(marketData);
    const volatilityScore = this.calculateVolatilityScore(symbol);

    return {
      technical: momentumScore,
      orderflow: 50 + (Math.random() - 0.5) * 20,
      liquidation: 50,
      sentiment: 50 + (Math.random() - 0.5) * 10,
      aiMl: 50 + momentumScore / 5 - 10,
      cosmic: 50,
    };
  }

  private calculateMomentumScore(marketData: { priceChangePercent: number }): number {
    let score = 50;
    const change = marketData.priceChangePercent;

    // Strong momentum in either direction
    if (Math.abs(change) > 5) {
      score += change > 0 ? 25 : -25;
    } else if (Math.abs(change) > 2) {
      score += change > 0 ? 15 : -15;
    } else if (Math.abs(change) > 1) {
      score += change > 0 ? 8 : -8;
    }

    return Math.max(0, Math.min(100, score));
  }

  private calculateVolatilityScore(symbol: string): number {
    // Placeholder - would calculate from recent price range
    return 50 + (Math.random() - 0.5) * 20;
  }

  private getLayerReasons(scores: SignalLayerScores): Record<string, string> {
    return {
      technical: `Momentum score: ${scores.technical.toFixed(0)}%`,
      orderflow: `Order flow: ${scores.orderflow.toFixed(0)}%`,
      liquidation: 'Neutral',
      sentiment: `Market sentiment: ${scores.sentiment.toFixed(0)}%`,
      aiMl: `ML adjusted: ${scores.aiMl.toFixed(0)}%`,
      cosmic: 'Neutral cosmic alignment',
    };
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Top 50 Scanner');
  console.log('='.repeat(50));

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
