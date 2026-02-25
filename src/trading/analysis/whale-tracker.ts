/**
 * Whale Tracking Analysis
 * Tracks large wallet movements, exchange flows, and smart money
 */

import type { SignalLayerScores } from '../utils/trading-types';

interface WhaleActivity {
  symbol: string;
  score: number;
  reason: string;
  largeOrders: LargeOrder[];
  exchangeFlow: ExchangeFlow;
  smartMoneySignal: 'accumulating' | 'distributing' | 'neutral';
}

interface LargeOrder {
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  valueUsd: number;
  timestamp: number;
}

interface ExchangeFlow {
  netFlow: number;
  inflow24h: number;
  outflow24h: number;
  signal: 'inflow' | 'outflow' | 'neutral';
}

const BYBIT_API_KEY = process.env.BYBIT_API_KEY || "";
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || "";
const BASE_URL = "https://api.bybit.com";

export class WhaleTracker {
  private cache = new Map<string, { data: WhaleActivity; timestamp: number }>();
  private cacheTtl = 120000; // 2 minutes

  /**
   * Track whale activity for a symbol
   */
  async analyze(symbol: string): Promise<WhaleActivity> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return cached.data;
    }

    try {
      const [largeOrders, orderbookWalls, liquidations] = await Promise.all([
        this.getLargeOrders(symbol),
        this.detectWalls(symbol),
        this.getRecentLiquidations(symbol),
      ]);

      // Analyze the data
      const analysis = this.analyzeWhaleBehavior(largeOrders, orderbookWalls, liquidations);

      const result: WhaleActivity = {
        symbol,
        score: analysis.score,
        reason: analysis.reason,
        largeOrders: largeOrders.slice(0, 10),
        exchangeFlow: analysis.flow,
        smartMoneySignal: analysis.signal,
      };

      this.cache.set(symbol, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error('[WhaleTracker] Error:', error);
      return {
        symbol,
        score: 50,
        reason: 'Whale tracking unavailable',
        largeOrders: [],
        exchangeFlow: { netFlow: 0, inflow24h: 0, outflow24h: 0, signal: 'neutral' },
        smartMoneySignal: 'neutral',
      };
    }
  }

  /**
   * Get large orders from recent trades
   */
  private async getLargeOrders(symbol: string): Promise<LargeOrder[]> {
    try {
      // Get recent public trades
      const res = await fetch(
        `${BASE_URL}/v5/market/recent-trade?category=linear&symbol=${symbol}&limit=200`
      );
      const data = await res.json();

      if (data.retCode !== 0 || !data.result?.list) {
        return [];
      }

      const trades = data.result.list;
      const largeOrders: LargeOrder[] = [];

      // Calculate average trade size to determine "large"
      const sizes = trades.map((t: any) => parseFloat(t.size));
      const avgSize = sizes.reduce((a: number, b: number) => a + b, 0) / sizes.length;
      const threshold = avgSize * 5; // 5x average = "large"

      for (const trade of trades) {
        const qty = parseFloat(trade.size);
        const price = parseFloat(trade.price);
        const valueUsd = qty * price;

        if (qty >= threshold) {
          largeOrders.push({
            side: trade.side.toLowerCase() as 'buy' | 'sell',
            price,
            quantity: qty,
            valueUsd,
            timestamp: parseInt(trade.time),
          });
        }
      }

      return largeOrders;
    } catch (error) {
      console.error('[WhaleTracker] Large orders error:', error);
      return [];
    }
  }

  /**
   * Detect orderbook walls (large bids/asks)
   */
  private async detectWalls(symbol: string): Promise<{ bidWalls: number; askWalls: number; totalBidValue: number; totalAskValue: number }> {
    try {
      const res = await fetch(
        `${BASE_URL}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`
      );
      const data = await res.json();

      if (data.retCode !== 0) {
        return { bidWalls: 0, askWalls: 0, totalBidValue: 0, totalAskValue: 0 };
      }

      const bids = data.result?.b || [];
      const asks = data.result?.a || [];

      // Calculate total value at each level
      const bidValues = bids.map((b: string[]) => parseFloat(b[0]) * parseFloat(b[1]));
      const askValues = asks.map((a: string[]) => parseFloat(a[0]) * parseFloat(a[1]));

      const totalBidValue = bidValues.reduce((a: number, b: number) => a + b, 0);
      const totalAskValue = askValues.reduce((a: number, b: number) => a + b, 0);

      // Detect walls (orders > 20% of total at single level)
      const bidAvg = totalBidValue / bids.length;
      const askAvg = totalAskValue / asks.length;

      const bidWalls = bidValues.filter((v: number) => v > bidAvg * 3).length;
      const askWalls = askValues.filter((v: number) => v > askAvg * 3).length;

      return { bidWalls, askWalls, totalBidValue, totalAskValue };
    } catch (error) {
      console.error('[WhaleTracker] Walls detection error:', error);
      return { bidWalls: 0, askWalls: 0, totalBidValue: 0, totalAskValue: 0 };
    }
  }

  /**
   * Get recent liquidations (whale casualties)
   */
  private async getRecentLiquidations(symbol: string): Promise<{ longLiq: number; shortLiq: number }> {
    try {
      // Bybit doesn't have public liquidation endpoint, use derivative data
      const res = await fetch(
        `${BASE_URL}/v5/market/tickers?category=linear&symbol=${symbol}`
      );
      const data = await res.json();

      if (data.retCode !== 0) {
        return { longLiq: 0, shortLiq: 0 };
      }

      const ticker = data.result?.list?.[0];
      if (!ticker) return { longLiq: 0, shortLiq: 0 };

      // Use open interest change as proxy for liquidation activity
      const oiChange = parseFloat(ticker.openInterestValue24h || '0');

      // Estimate liquidation impact from price movement
      const priceChange = parseFloat(ticker.price24hPcnt) * 100;

      // If price dropped significantly, longs likely liquidated
      // If price rose significantly, shorts likely liquidated
      let longLiq = 0;
      let shortLiq = 0;

      if (priceChange < -3) {
        longLiq = Math.abs(priceChange) * oiChange * 0.01;
      } else if (priceChange > 3) {
        shortLiq = priceChange * oiChange * 0.01;
      }

      return { longLiq, shortLiq };
    } catch (error) {
      console.error('[WhaleTracker] Liquidations error:', error);
      return { longLiq: 0, shortLiq: 0 };
    }
  }

  /**
   * Analyze whale behavior and generate signal
   */
  private analyzeWhaleBehavior(
    largeOrders: LargeOrder[],
    walls: { bidWalls: number; askWalls: number; totalBidValue: number; totalAskValue: number },
    liquidations: { longLiq: number; shortLiq: number }
  ): { score: number; reason: string; signal: 'accumulating' | 'distributing' | 'neutral'; flow: ExchangeFlow } {
    let score = 50;
    let reasons: string[] = [];
    let signal: 'accumulating' | 'distributing' | 'neutral' = 'neutral';

    // Analyze large orders
    const buyOrders = largeOrders.filter(o => o.side === 'buy');
    const sellOrders = largeOrders.filter(o => o.side === 'sell');
    const buyVolume = buyOrders.reduce((s, o) => s + o.valueUsd, 0);
    const sellVolume = sellOrders.reduce((s, o) => s + o.valueUsd, 0);

    if (buyVolume > sellVolume * 1.5) {
      score += 15;
      reasons.push('Whale buying pressure');
      signal = 'accumulating';
    } else if (sellVolume > buyVolume * 1.5) {
      score -= 15;
      reasons.push('Whale selling pressure');
      signal = 'distributing';
    }

    // Analyze orderbook walls
    if (walls.bidWalls > walls.askWalls * 2) {
      score += 10;
      reasons.push('Strong bid walls');
    } else if (walls.askWalls > walls.bidWalls * 2) {
      score -= 10;
      reasons.push('Strong ask walls');
    }

    // Orderbook imbalance
    const imbalance = (walls.totalBidValue - walls.totalAskValue) / (walls.totalBidValue + walls.totalAskValue);
    score += imbalance * 20;

    // Liquidation cascade opportunities
    if (liquidations.shortLiq > liquidations.longLiq * 2) {
      score += 10;
      reasons.push('Short squeeze potential');
    } else if (liquidations.longLiq > liquidations.shortLiq * 2) {
      score -= 10;
      reasons.push('Long liquidation cascade');
    }

    const flow: ExchangeFlow = {
      netFlow: buyVolume - sellVolume,
      inflow24h: buyVolume,
      outflow24h: sellVolume,
      signal: buyVolume > sellVolume ? 'outflow' : sellVolume > buyVolume ? 'inflow' : 'neutral',
    };

    return {
      score: Math.max(0, Math.min(100, score)),
      reason: reasons.length > 0 ? reasons.join(', ') : 'Neutral whale activity',
      signal,
      flow,
    };
  }
}

// Export singleton
export const whaleTracker = new WhaleTracker();
