/**
 * Trade Journal with Learning
 * Records trades, analyzes patterns, learns from wins/losses
 */

import { createClient } from "@supabase/supabase-js";

interface TradeRecord {
  id?: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPercent: number;
  entryReason: string;
  exitReason: string;
  signalConfidence: number;
  marketConditions: MarketConditions;
  openedAt: Date;
  closedAt: Date;
  lessons: string[];
}

interface MarketConditions {
  trend: 'up' | 'down' | 'sideways';
  volatility: 'low' | 'medium' | 'high';
  volume: 'low' | 'normal' | 'high';
  fearGreedIndex: number;
}

interface TradePattern {
  pattern: string;
  winRate: number;
  avgPnl: number;
  sampleSize: number;
  lastUpdated: Date;
}

interface LearningInsight {
  insight: string;
  category: 'entry' | 'exit' | 'risk' | 'market' | 'psychology';
  confidence: number;
  basedOnTrades: number;
}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export class TradeJournal {
  private trades: TradeRecord[] = [];
  private patterns: TradePattern[] = [];
  private insights: LearningInsight[] = [];

  constructor() {
    this.loadFromDatabase();
  }

  /**
   * Record a new trade
   */
  async recordTrade(trade: TradeRecord): Promise<void> {
    // Add to memory
    this.trades.push(trade);

    // Save to database
    if (supabase) {
      try {
        await supabase.from('trade_journal').insert({
          symbol: trade.symbol,
          side: trade.side,
          entry_price: trade.entryPrice,
          exit_price: trade.exitPrice,
          size: trade.size,
          leverage: trade.leverage,
          pnl: trade.pnl,
          pnl_percent: trade.pnlPercent,
          entry_reason: trade.entryReason,
          exit_reason: trade.exitReason,
          signal_confidence: trade.signalConfidence,
          market_trend: trade.marketConditions.trend,
          market_volatility: trade.marketConditions.volatility,
          market_volume: trade.marketConditions.volume,
          fear_greed_index: trade.marketConditions.fearGreedIndex,
          lessons: trade.lessons,
          opened_at: trade.openedAt.toISOString(),
          closed_at: trade.closedAt.toISOString(),
        });
      } catch (error) {
        console.error('[TradeJournal] Save error:', error);
      }
    }

    // Trigger learning
    await this.analyzeAndLearn();
  }

  /**
   * Get trading statistics
   */
  getStats(): {
    totalTrades: number;
    winRate: number;
    avgPnl: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    bestTrade: TradeRecord | null;
    worstTrade: TradeRecord | null;
    streaks: { current: number; longestWin: number; longestLoss: number };
  } {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl < 0);

    const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    // Calculate streaks
    let currentStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let tempWinStreak = 0;
    let tempLossStreak = 0;

    for (const trade of this.trades) {
      if (trade.pnl > 0) {
        tempWinStreak++;
        tempLossStreak = 0;
        longestWinStreak = Math.max(longestWinStreak, tempWinStreak);
      } else {
        tempLossStreak++;
        tempWinStreak = 0;
        longestLossStreak = Math.max(longestLossStreak, tempLossStreak);
      }
    }
    currentStreak = this.trades.length > 0 && this.trades[this.trades.length - 1].pnl > 0
      ? tempWinStreak : -tempLossStreak;

    return {
      totalTrades: this.trades.length,
      winRate: this.trades.length > 0 ? (wins.length / this.trades.length) * 100 : 0,
      avgPnl: this.trades.length > 0 ? this.trades.reduce((s, t) => s + t.pnl, 0) / this.trades.length : 0,
      avgWin: wins.length > 0 ? totalWins / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
      profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
      bestTrade: wins.length > 0 ? wins.reduce((a, b) => a.pnl > b.pnl ? a : b) : null,
      worstTrade: losses.length > 0 ? losses.reduce((a, b) => a.pnl < b.pnl ? a : b) : null,
      streaks: {
        current: currentStreak,
        longestWin: longestWinStreak,
        longestLoss: longestLossStreak,
      },
    };
  }

  /**
   * Analyze trades and learn patterns
   */
  private async analyzeAndLearn(): Promise<void> {
    if (this.trades.length < 5) return;

    // Analyze by market condition
    await this.analyzeByCondition('trend');
    await this.analyzeByCondition('volatility');
    await this.analyzeByCondition('volume');

    // Analyze by signal confidence
    await this.analyzeByConfidence();

    // Analyze by symbol
    await this.analyzeBySymbol();

    // Generate insights
    await this.generateInsights();
  }

  /**
   * Analyze win rate by market condition
   */
  private async analyzeByCondition(condition: 'trend' | 'volatility' | 'volume'): Promise<void> {
    const groups = new Map<string, { wins: number; losses: number; pnl: number }>();

    for (const trade of this.trades) {
      let key: string;
      if (condition === 'trend') key = trade.marketConditions.trend;
      else if (condition === 'volatility') key = trade.marketConditions.volatility;
      else key = trade.marketConditions.volume;

      const group = groups.get(key) || { wins: 0, losses: 0, pnl: 0 };
      if (trade.pnl > 0) group.wins++;
      else group.losses++;
      group.pnl += trade.pnl;
      groups.set(key, group);
    }

    for (const [key, stats] of groups) {
      const total = stats.wins + stats.losses;
      if (total >= 3) {
        const winRate = (stats.wins / total) * 100;
        const avgPnl = stats.pnl / total;

        // Update or create pattern
        const patternName = `${condition}_${key}`;
        const existingIndex = this.patterns.findIndex(p => p.pattern === patternName);

        if (existingIndex >= 0) {
          this.patterns[existingIndex] = {
            pattern: patternName,
            winRate,
            avgPnl,
            sampleSize: total,
            lastUpdated: new Date(),
          };
        } else {
          this.patterns.push({
            pattern: patternName,
            winRate,
            avgPnl,
            sampleSize: total,
            lastUpdated: new Date(),
          });
        }
      }
    }
  }

  /**
   * Analyze by signal confidence level
   */
  private async analyzeByConfidence(): Promise<void> {
    const buckets = {
      low: { min: 0, max: 60, wins: 0, losses: 0, pnl: 0 },
      medium: { min: 60, max: 75, wins: 0, losses: 0, pnl: 0 },
      high: { min: 75, max: 100, wins: 0, losses: 0, pnl: 0 },
    };

    for (const trade of this.trades) {
      const conf = trade.signalConfidence;
      let bucket: keyof typeof buckets;

      if (conf < 60) bucket = 'low';
      else if (conf < 75) bucket = 'medium';
      else bucket = 'high';

      if (trade.pnl > 0) buckets[bucket].wins++;
      else buckets[bucket].losses++;
      buckets[bucket].pnl += trade.pnl;
    }

    for (const [level, stats] of Object.entries(buckets)) {
      const total = stats.wins + stats.losses;
      if (total >= 3) {
        this.patterns.push({
          pattern: `confidence_${level}`,
          winRate: (stats.wins / total) * 100,
          avgPnl: stats.pnl / total,
          sampleSize: total,
          lastUpdated: new Date(),
        });
      }
    }
  }

  /**
   * Analyze by trading symbol
   */
  private async analyzeBySymbol(): Promise<void> {
    const symbolStats = new Map<string, { wins: number; losses: number; pnl: number }>();

    for (const trade of this.trades) {
      const stats = symbolStats.get(trade.symbol) || { wins: 0, losses: 0, pnl: 0 };
      if (trade.pnl > 0) stats.wins++;
      else stats.losses++;
      stats.pnl += trade.pnl;
      symbolStats.set(trade.symbol, stats);
    }

    for (const [symbol, stats] of symbolStats) {
      const total = stats.wins + stats.losses;
      if (total >= 3) {
        this.patterns.push({
          pattern: `symbol_${symbol}`,
          winRate: (stats.wins / total) * 100,
          avgPnl: stats.pnl / total,
          sampleSize: total,
          lastUpdated: new Date(),
        });
      }
    }
  }

  /**
   * Generate actionable insights from patterns
   */
  private async generateInsights(): Promise<void> {
    this.insights = [];

    // Best performing conditions
    const bestPatterns = this.patterns
      .filter(p => p.sampleSize >= 3 && p.winRate > 55)
      .sort((a, b) => b.winRate - a.winRate);

    if (bestPatterns.length > 0) {
      const best = bestPatterns[0];
      this.insights.push({
        insight: `Best performance in ${best.pattern.replace(/_/g, ' ')}: ${best.winRate.toFixed(0)}% win rate`,
        category: 'market',
        confidence: Math.min(100, best.sampleSize * 10),
        basedOnTrades: best.sampleSize,
      });
    }

    // Worst performing conditions
    const worstPatterns = this.patterns
      .filter(p => p.sampleSize >= 3 && p.winRate < 45)
      .sort((a, b) => a.winRate - b.winRate);

    if (worstPatterns.length > 0) {
      const worst = worstPatterns[0];
      this.insights.push({
        insight: `Avoid trading in ${worst.pattern.replace(/_/g, ' ')}: ${worst.winRate.toFixed(0)}% win rate`,
        category: 'market',
        confidence: Math.min(100, worst.sampleSize * 10),
        basedOnTrades: worst.sampleSize,
      });
    }

    // Leverage analysis
    const highLeverageTrades = this.trades.filter(t => t.leverage >= 50);
    const lowLeverageTrades = this.trades.filter(t => t.leverage < 30);

    if (highLeverageTrades.length >= 5 && lowLeverageTrades.length >= 5) {
      const highLevWinRate = highLeverageTrades.filter(t => t.pnl > 0).length / highLeverageTrades.length;
      const lowLevWinRate = lowLeverageTrades.filter(t => t.pnl > 0).length / lowLeverageTrades.length;

      if (lowLevWinRate > highLevWinRate + 0.1) {
        this.insights.push({
          insight: `Lower leverage performs better: ${(lowLevWinRate * 100).toFixed(0)}% vs ${(highLevWinRate * 100).toFixed(0)}% win rate`,
          category: 'risk',
          confidence: 70,
          basedOnTrades: highLeverageTrades.length + lowLeverageTrades.length,
        });
      }
    }

    // Confidence threshold analysis
    const lowConfTrades = this.trades.filter(t => t.signalConfidence < 70);
    if (lowConfTrades.length >= 5) {
      const lowConfWinRate = lowConfTrades.filter(t => t.pnl > 0).length / lowConfTrades.length;
      if (lowConfWinRate < 0.4) {
        this.insights.push({
          insight: `Signals below 70% confidence have ${(lowConfWinRate * 100).toFixed(0)}% win rate - consider higher threshold`,
          category: 'entry',
          confidence: 75,
          basedOnTrades: lowConfTrades.length,
        });
      }
    }
  }

  /**
   * Get learning recommendations
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];

    for (const insight of this.insights.sort((a, b) => b.confidence - a.confidence).slice(0, 5)) {
      recommendations.push(insight.insight);
    }

    // Add general recommendations based on stats
    const stats = this.getStats();

    if (stats.winRate < 40) {
      recommendations.push('Win rate is low - consider tightening entry criteria or paper trading');
    }

    if (stats.profitFactor < 1) {
      recommendations.push('Profit factor below 1 - losses exceed gains. Review position sizing.');
    }

    if (Math.abs(stats.streaks.current) >= 3) {
      if (stats.streaks.current > 0) {
        recommendations.push(`On a ${stats.streaks.current}-trade win streak - stay disciplined, don\'t increase size`);
      } else {
        recommendations.push(`On a ${Math.abs(stats.streaks.current)}-trade loss streak - consider taking a break`);
      }
    }

    return recommendations;
  }

  /**
   * Check if conditions are favorable based on learning
   */
  isConditionFavorable(conditions: Partial<MarketConditions>): { favorable: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let favorable = true;

    for (const pattern of this.patterns) {
      if (pattern.sampleSize < 3) continue;

      // Check trend
      if (conditions.trend && pattern.pattern === `trend_${conditions.trend}`) {
        if (pattern.winRate < 40) {
          favorable = false;
          reasons.push(`${conditions.trend} trend has ${pattern.winRate.toFixed(0)}% win rate`);
        } else if (pattern.winRate > 60) {
          reasons.push(`${conditions.trend} trend has ${pattern.winRate.toFixed(0)}% win rate (favorable)`);
        }
      }

      // Check volatility
      if (conditions.volatility && pattern.pattern === `volatility_${conditions.volatility}`) {
        if (pattern.winRate < 40) {
          favorable = false;
          reasons.push(`${conditions.volatility} volatility has ${pattern.winRate.toFixed(0)}% win rate`);
        }
      }
    }

    return { favorable, reasons };
  }

  /**
   * Load trades from database
   */
  private async loadFromDatabase(): Promise<void> {
    if (!supabase) return;

    try {
      const { data, error } = await supabase
        .from('trade_journal')
        .select('*')
        .order('closed_at', { ascending: false })
        .limit(100);

      if (!error && data) {
        this.trades = data.map((row: any) => ({
          symbol: row.symbol,
          side: row.side,
          entryPrice: row.entry_price,
          exitPrice: row.exit_price,
          size: row.size,
          leverage: row.leverage,
          pnl: row.pnl,
          pnlPercent: row.pnl_percent,
          entryReason: row.entry_reason,
          exitReason: row.exit_reason,
          signalConfidence: row.signal_confidence,
          marketConditions: {
            trend: row.market_trend,
            volatility: row.market_volatility,
            volume: row.market_volume,
            fearGreedIndex: row.fear_greed_index,
          },
          lessons: row.lessons || [],
          openedAt: new Date(row.opened_at),
          closedAt: new Date(row.closed_at),
        }));
      }

      // Run initial analysis
      await this.analyzeAndLearn();
    } catch (error) {
      console.error('[TradeJournal] Load error:', error);
    }
  }
}

// Export singleton
export const tradeJournal = new TradeJournal();
