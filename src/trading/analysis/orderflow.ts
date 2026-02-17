/**
 * BEHEMOTH Order Flow Analysis Module
 *
 * Analyzes orderbook depth, funding rates, and market microstructure
 */

import type { Orderbook, OrderbookLevel, OrderbookAnalysis, FundingRate } from '../utils/trading-types';

// ============================================================
// Orderbook Analysis
// ============================================================

export function analyzeOrderbook(orderbook: Orderbook): OrderbookAnalysis {
  const { bids, asks } = orderbook;

  // Calculate depths
  const bidDepth = bids.reduce((sum, b) => sum + b.quantity, 0);
  const askDepth = asks.reduce((sum, a) => sum + a.quantity, 0);

  // Bid/Ask ratio
  const totalDepth = bidDepth + askDepth;
  const bidAskRatio = totalDepth > 0 ? bidDepth / totalDepth : 0.5;

  // Spread
  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadPercent = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0;

  // Imbalance (-1 to 1)
  const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  // Find large walls (3x average size)
  const avgBidSize = bidDepth / bids.length;
  const avgAskSize = askDepth / asks.length;

  const largeBidWalls = bids
    .filter((b) => b.quantity > avgBidSize * 3)
    .slice(0, 5);

  const largeAskWalls = asks
    .filter((a) => a.quantity > avgAskSize * 3)
    .slice(0, 5);

  // Calculate support/resistance levels from orderbook
  const supportLevels = identifySupportLevels(bids, 5);
  const resistanceLevels = identifyResistanceLevels(asks, 5);

  return {
    bidDepth,
    askDepth,
    bidAskRatio,
    spreadPercent,
    imbalance,
    largeBidWalls,
    largeAskWalls,
    supportLevels,
    resistanceLevels,
  };
}

function identifySupportLevels(bids: OrderbookLevel[], count: number): number[] {
  // Find price levels with significant bid concentration
  const levels: { price: number; volume: number }[] = [];
  const priceLevelSize = bids.length > 0 ? (bids[0].price - bids[bids.length - 1].price) / 10 : 0;

  for (let i = 0; i < bids.length; i++) {
    const price = bids[i].price;
    const volume = bids[i].quantity;

    // Group by price level
    const levelIndex = levels.findIndex(
      (l) => Math.abs(l.price - price) < priceLevelSize
    );

    if (levelIndex >= 0) {
      levels[levelIndex].volume += volume;
    } else {
      levels.push({ price, volume });
    }
  }

  // Sort by volume and return top levels
  return levels
    .sort((a, b) => b.volume - a.volume)
    .slice(0, count)
    .map((l) => l.price);
}

function identifyResistanceLevels(asks: OrderbookLevel[], count: number): number[] {
  const levels: { price: number; volume: number }[] = [];
  const priceLevelSize = asks.length > 0 ? (asks[asks.length - 1].price - asks[0].price) / 10 : 0;

  for (let i = 0; i < asks.length; i++) {
    const price = asks[i].price;
    const volume = asks[i].quantity;

    const levelIndex = levels.findIndex(
      (l) => Math.abs(l.price - price) < priceLevelSize
    );

    if (levelIndex >= 0) {
      levels[levelIndex].volume += volume;
    } else {
      levels.push({ price, volume });
    }
  }

  return levels
    .sort((a, b) => b.volume - a.volume)
    .slice(0, count)
    .map((l) => l.price);
}

// ============================================================
// Order Flow Score
// ============================================================

export interface OrderFlowScore {
  score: number; // 0-100
  bias: 'bullish' | 'bearish' | 'neutral';
  reasons: string[];
}

export function calculateOrderFlowScore(analysis: OrderbookAnalysis): OrderFlowScore {
  const reasons: string[] = [];
  let score = 50; // Neutral baseline

  // Imbalance impact
  if (analysis.imbalance > 0.2) {
    score += 20;
    reasons.push(`Strong bid imbalance (+${(analysis.imbalance * 100).toFixed(1)}%)`);
  } else if (analysis.imbalance < -0.2) {
    score -= 20;
    reasons.push(`Strong ask imbalance (${(analysis.imbalance * 100).toFixed(1)}%)`);
  } else if (analysis.imbalance > 0.1) {
    score += 10;
    reasons.push(`Moderate bid imbalance`);
  } else if (analysis.imbalance < -0.1) {
    score -= 10;
    reasons.push(`Moderate ask imbalance`);
  }

  // Wall analysis
  if (analysis.largeBidWalls.length > analysis.largeAskWalls.length) {
    score += 10;
    reasons.push(`${analysis.largeBidWalls.length} bid walls detected`);
  } else if (analysis.largeAskWalls.length > analysis.largeBidWalls.length) {
    score -= 10;
    reasons.push(`${analysis.largeAskWalls.length} ask walls detected`);
  }

  // Spread analysis
  if (analysis.spreadPercent < 0.01) {
    score += 5;
    reasons.push('Tight spread (high liquidity)');
  } else if (analysis.spreadPercent > 0.1) {
    score -= 10;
    reasons.push('Wide spread (low liquidity)');
  }

  // Determine bias
  let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (score >= 60) bias = 'bullish';
  else if (score <= 40) bias = 'bearish';

  return {
    score: Math.max(0, Math.min(100, score)),
    bias,
    reasons,
  };
}

// ============================================================
// Funding Rate Analysis
// ============================================================

export interface FundingAnalysis {
  currentRate: number;
  predictedRate?: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  pressure: number; // -100 to 100
  recommendation: string;
}

export function analyzeFundingRate(funding: FundingRate): FundingAnalysis {
  const rate = funding.fundingRate;
  const predicted = funding.predictedRate;

  // Interpret funding rate
  let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let pressure = 0;
  let recommendation = '';

  // Annualized rate for context
  const annualizedRate = rate * 3 * 365 * 100; // 3 funding periods per day

  if (rate > 0.0005) {
    // > 0.05% per 8h = >54% APR
    sentiment = 'bullish';
    pressure = Math.min(100, rate * 100000);
    recommendation = 'High positive funding - longs paying shorts. Consider mean reversion.';
  } else if (rate > 0.0001) {
    sentiment = 'bullish';
    pressure = rate * 50000;
    recommendation = 'Moderate positive funding - slight long bias.';
  } else if (rate < -0.0005) {
    sentiment = 'bearish';
    pressure = Math.max(-100, rate * 100000);
    recommendation = 'High negative funding - shorts paying longs. Consider mean reversion.';
  } else if (rate < -0.0001) {
    sentiment = 'bearish';
    pressure = rate * 50000;
    recommendation = 'Moderate negative funding - slight short bias.';
  } else {
    recommendation = 'Neutral funding - balanced market.';
  }

  // Consider predicted rate if available
  if (predicted !== undefined && Math.abs(predicted - rate) > 0.0001) {
    if (predicted > rate) {
      recommendation += ' Funding rate expected to increase.';
    } else {
      recommendation += ' Funding rate expected to decrease.';
    }
  }

  return {
    currentRate: rate,
    predictedRate: predicted,
    sentiment,
    pressure,
    recommendation,
  };
}

// ============================================================
// Volume Profile
// ============================================================

export interface VolumeProfileLevel {
  price: number;
  volume: number;
  type: 'bid' | 'ask';
}

export interface VolumeProfileAnalysis {
  poc: number; // Point of Control
  vah: number; // Value Area High
  val: number; // Value Area Low
  imbalance: number;
}

export function calculateVolumeProfile(
  trades: Array<{ price: number; volume: number; side: 'buy' | 'sell' }>,
  tickSize: number = 0.01
): VolumeProfileAnalysis {
  if (trades.length === 0) {
    return { poc: 0, vah: 0, val: 0, imbalance: 0 };
  }

  // Aggregate volume by price level
  const profile: Map<number, { bid: number; ask: number }> = new Map();

  for (const trade of trades) {
    const priceLevel = Math.round(trade.price / tickSize) * tickSize;
    const existing = profile.get(priceLevel) || { bid: 0, ask: 0 };

    if (trade.side === 'buy') {
      existing.bid += trade.volume;
    } else {
      existing.ask += trade.volume;
    }

    profile.set(priceLevel, existing);
  }

  // Find POC (price with most volume)
  let pocPrice = 0;
  let maxVolume = 0;

  for (const [price, vol] of profile) {
    const total = vol.bid + vol.ask;
    if (total > maxVolume) {
      maxVolume = total;
      pocPrice = price;
    }
  }

  // Calculate value area (70% of volume)
  const totalVolume = trades.reduce((sum, t) => sum + t.volume, 0);
  const targetVolume = totalVolume * 0.7;

  // Sort prices by distance from POC
  const sortedPrices = Array.from(profile.keys()).sort(
    (a, b) => Math.abs(a - pocPrice) - Math.abs(b - pocPrice)
  );

  let volumeAccum = 0;
  let vah = pocPrice;
  let val = pocPrice;

  for (const price of sortedPrices) {
    const vol = profile.get(price)!;
    volumeAccum += vol.bid + vol.ask;

    if (price > vah) vah = price;
    if (price < val) val = price;

    if (volumeAccum >= targetVolume) break;
  }

  // Calculate imbalance
  let totalBid = 0;
  let totalAsk = 0;
  for (const vol of profile.values()) {
    totalBid += vol.bid;
    totalAsk += vol.ask;
  }
  const imbalance = (totalBid - totalAsk) / (totalBid + totalAsk);

  return { poc: pocPrice, vah, val, imbalance };
}

// ============================================================
// Cumulative Volume Delta (CVD)
// ============================================================

export interface CVDPoint {
  timestamp: Date;
  delta: number;
  cumulative: number;
}

export function calculateCVD(
  trades: Array<{ timestamp: Date; volume: number; side: 'buy' | 'sell' }>
): CVDPoint[] {
  const points: CVDPoint[] = [];
  let cumulative = 0;

  for (const trade of trades) {
    const delta = trade.side === 'buy' ? trade.volume : -trade.volume;
    cumulative += delta;

    points.push({
      timestamp: trade.timestamp,
      delta,
      cumulative,
    });
  }

  return points;
}

export function analyzeCVDDivergence(
  cvd: CVDPoint[],
  prices: number[]
): { divergence: boolean; type: 'bullish' | 'bearish' | null; strength: number } {
  if (cvd.length < 10 || prices.length < 10) {
    return { divergence: false, type: null, strength: 0 };
  }

  const recentCVD = cvd.slice(-10);
  const recentPrices = prices.slice(-10);

  // Calculate trends
  const cvdTrend = recentCVD[recentCVD.length - 1].cumulative - recentCVD[0].cumulative;
  const priceTrend = recentPrices[recentPrices.length - 1] - recentPrices[0];

  // Check for divergence
  let divergence = false;
  let type: 'bullish' | 'bearish' | null = null;
  let strength = 0;

  // Bullish divergence: price down, CVD up
  if (priceTrend < 0 && cvdTrend > 0) {
    divergence = true;
    type = 'bullish';
    strength = Math.min(100, (Math.abs(cvdTrend) / Math.abs(priceTrend)) * 50);
  }
  // Bearish divergence: price up, CVD down
  else if (priceTrend > 0 && cvdTrend < 0) {
    divergence = true;
    type = 'bearish';
    strength = Math.min(100, (Math.abs(cvdTrend) / Math.abs(priceTrend)) * 50);
  }

  return { divergence, type, strength };
}
