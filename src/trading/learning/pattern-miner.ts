/**
 * BEHEMOTH Pattern Miner
 *
 * Discovers trading patterns from historical data:
 * - Price action patterns
 * - Indicator combinations
 * - Time-based patterns
 * - Statistical significance testing
 */

import { createClient } from "@supabase/supabase-js";

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ============================================================
// Pattern Types
// ============================================================

interface Pattern {
  name: string;
  type: 'price_action' | 'indicator_signal' | 'time_based' | 'correlation';
  conditions: Record<string, any>;
  timeframe: string;
  occurrences: number;
  successes: number;
  successRate: number;
  avgReturn: number;
  pValue?: number;
  isSignificant: boolean;
}

// ============================================================
// Pattern Miner Class
// ============================================================

export class PatternMiner {
  private minOccurrences: number = 10;
  private significanceLevel: number = 0.05;

  /**
   * Run pattern mining on historical trades
   */
  async minePatterns(): Promise<Pattern[]> {
    console.log('[PatternMiner] Starting pattern mining...');

    const patterns: Pattern[] = [];

    // Mine different pattern types
    patterns.push(...await this.minePriceActionPatterns());
    patterns.push(...await this.mineIndicatorPatterns());
    patterns.push(...await this.mineTimePatterns());
    patterns.push(...await this.mineTradeContextPatterns());

    // Filter for significance
    const significantPatterns = patterns.filter(p => p.isSignificant);

    console.log(`[PatternMiner] Found ${significantPatterns.length} significant patterns`);

    // Save to database
    await this.savePatterns(significantPatterns);

    return significantPatterns;
  }

  /**
   * Mine price action patterns
   */
  private async minePriceActionPatterns(): Promise<Pattern[]> {
    if (!supabase) return [];

    const patterns: Pattern[] = [];

    // Get trades with journal data
    const { data: trades } = await supabase
      .from('trade_executions')
      .select(`
        *,
        trade_journal (*)
      `)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(500);

    if (!trades || trades.length < this.minOccurrences) return [];

    // Pattern: RSI oversold bounce
    const rsiOversoldPattern = this.analyzePattern(
      trades,
      (t: any) => {
        // Would need indicator data stored
        return t.trade_journal?.pattern_tags?.includes('rsi_oversold');
      },
      'RSI Oversold Bounce',
      'indicator_signal'
    );
    if (rsiOversoldPattern) patterns.push(rsiOversoldPattern);

    // Pattern: Breakout after consolidation
    const breakoutPattern = this.analyzePattern(
      trades,
      (t: any) => t.trade_journal?.pattern_tags?.includes('breakout'),
      'Breakout',
      'price_action'
    );
    if (breakoutPattern) patterns.push(breakoutPattern);

    // Pattern: Support/Respect test
    const supportPattern = this.analyzePattern(
      trades,
      (t: any) => t.trade_journal?.pattern_tags?.includes('support_test'),
      'Support Test',
      'price_action'
    );
    if (supportPattern) patterns.push(supportPattern);

    return patterns;
  }

  /**
   * Mine indicator combination patterns
   */
  private async mineIndicatorPatterns(): Promise<Pattern[]> {
    if (!supabase) return [];

    const patterns: Pattern[] = [];

    const { data: signals } = await supabase
      .from('trading_signals')
      .select(`
        *,
        trade_executions (
          realized_pnl,
          realized_pnl_percent
        ),
        signal_performance (*)
      `)
      .eq('status', 'executed')
      .order('created_at', { ascending: false })
      .limit(500);

    if (!signals || signals.length < this.minOccurrences) return [];

    // Pattern: High technical + high AI
    const techAIPattern = this.analyzePattern(
      signals,
      (s: any) => s.layer_technical >= 70 && s.layer_ai_ml >= 70,
      'High Technical + AI Alignment',
      'indicator_signal'
    );
    if (techAIPattern) patterns.push(techAIPattern);

    // Pattern: Liquidation cascade
    const liqPattern = this.analyzePattern(
      signals,
      (s: any) => s.layer_liquidation >= 75,
      'Liquidation Cascade',
      'indicator_signal'
    );
    if (liqPattern) patterns.push(liqPattern);

    // Pattern: Order flow surge
    const ofPattern = this.analyzePattern(
      signals,
      (s: any) => s.layer_orderflow >= 70,
      'Order Flow Surge',
      'indicator_signal'
    );
    if (ofPattern) patterns.push(ofPattern);

    return patterns;
  }

  /**
   * Mine time-based patterns
   */
  private async mineTimePatterns(): Promise<Pattern[]> {
    if (!supabase) return [];

    const patterns: Pattern[] = [];

    const { data: trades } = await supabase
      .from('trade_executions')
      .select('*')
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(500);

    if (!trades || trades.length < this.minOccurrences) return [];

    // Pattern: London session
    const londonPattern = this.analyzePattern(
      trades,
      (t: any) => {
        const hour = new Date(t.opened_at).getUTCHours();
        return hour >= 7 && hour < 16;
      },
      'London Session',
      'time_based'
    );
    if (londonPattern) patterns.push(londonPattern);

    // Pattern: New York open
    const nyOpenPattern = this.analyzePattern(
      trades,
      (t: any) => {
        const hour = new Date(t.opened_at).getUTCHours();
        return hour >= 13 && hour < 16;
      },
      'NY Open Volatility',
      'time_based'
    );
    if (nyOpenPattern) patterns.push(nyOpenPattern);

    // Pattern: End of day
    const eodPattern = this.analyzePattern(
      trades,
      (t: any) => {
        const hour = new Date(t.opened_at).getUTCHours();
        return hour >= 20 || hour < 2;
      },
      'End of Day',
      'time_based'
    );
    if (eodPattern) patterns.push(eodPattern);

    // Pattern: Monday effect
    const mondayPattern = this.analyzePattern(
      trades,
      (t: any) => new Date(t.opened_at).getDay() === 1,
      'Monday',
      'time_based'
    );
    if (mondayPattern) patterns.push(mondayPattern);

    // Pattern: Friday close
    const fridayPattern = this.analyzePattern(
      trades,
      (t: any) => new Date(t.opened_at).getDay() === 5,
      'Friday',
      'time_based'
    );
    if (fridayPattern) patterns.push(fridayPattern);

    return patterns;
  }

  /**
   * Mine trade context patterns
   */
  private async mineTradeContextPatterns(): Promise<Pattern[]> {
    if (!supabase) return [];

    const patterns: Pattern[] = [];

    const { data: trades } = await supabase
      .from('trade_executions')
      .select(`
        *,
        trade_journal (*)
      `)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(500);

    if (!trades || trades.length < this.minOccurrences) return [];

    // Pattern: High leverage wins
    const highLevPattern = this.analyzePattern(
      trades,
      (t: any) => t.leverage >= 75,
      'High Leverage (75x+)',
      'indicator_signal'
    );
    if (highLevPattern) patterns.push(highLevPattern);

    // Pattern: Scanner tier performance
    const top10Pattern = this.analyzePattern(
      trades,
      async (t: any) => {
        const { data } = await supabase
          .from('trading_signals')
          .select('scanner_tier')
          .eq('execution_id', t.id)
          .single();
        return data?.scanner_tier === 'top10';
      },
      'Top 10 Scanner',
      'indicator_signal'
    );
    if (top10Pattern) patterns.push(top10Pattern);

    return patterns;
  }

  /**
   * Analyze a specific pattern
   */
  private analyzePattern(
    data: any[],
    condition: (item: any) => boolean | Promise<boolean>,
    name: string,
    type: Pattern['type']
  ): Pattern | null {
    const matching = data.filter(item => {
      try {
        const result = condition(item);
        return typeof result === 'boolean' ? result : false;
      } catch {
        return false;
      }
    });

    if (matching.length < this.minOccurrences) return null;

    const successes = matching.filter(
      (t: any) => (t.realized_pnl || t.trade_executions?.realized_pnl || 0) > 0
    );

    const returns = matching.map(
      (t: any) => t.realized_pnl_percent || t.trade_executions?.realized_pnl_percent || 0
    );

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const successRate = (successes.length / matching.length) * 100;

    // Calculate p-value using binomial test
    // H0: success rate = 50%
    // H1: success rate > 50%
    const pValue = this.binomialTest(successes.length, matching.length, 0.5);

    return {
      name,
      type,
      conditions: { name },
      timeframe: 'various',
      occurrences: matching.length,
      successes: successes.length,
      successRate,
      avgReturn,
      pValue,
      isSignificant: pValue < this.significanceLevel && successRate > 55,
    };
  }

  /**
   * Simple binomial test (one-tailed)
   */
  private binomialTest(successes: number, trials: number, p0: number): number {
    // Normal approximation for large samples
    const mean = trials * p0;
    const stdDev = Math.sqrt(trials * p0 * (1 - p0));
    const zScore = (successes - mean) / stdDev;

    // Approximate p-value from z-score
    // This is a simplified approximation
    const p = this.normalCDF(-zScore);
    return p;
  }

  /**
   * Standard normal CDF approximation
   */
  private normalCDF(x: number): number {
    // Approximation using error function
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Save patterns to database
   */
  private async savePatterns(patterns: Pattern[]): Promise<void> {
    if (!supabase) return;

    for (const pattern of patterns) {
      try {
        await supabase.from('mined_patterns').upsert({
          pattern_name: pattern.name,
          pattern_type: pattern.type,
          conditions: pattern.conditions,
          timeframe: pattern.timeframe,
          occurrence_count: pattern.occurrences,
          success_count: pattern.successes,
          fail_count: pattern.occurrences - pattern.successes,
          success_rate: pattern.successRate,
          avg_return: pattern.avgReturn,
          p_value: pattern.pValue,
          is_significant: pattern.isSignificant,
          mined_at: new Date().toISOString(),
        }, {
          onConflict: 'pattern_name',
        });
      } catch (error) {
        console.error(`[PatternMiner] Error saving pattern ${pattern.name}:`, error);
      }
    }
  }

  /**
   * Get top patterns for a given context
   */
  async getTopPatterns(limit: number = 10): Promise<Pattern[]> {
    if (!supabase) return [];

    const { data } = await supabase
      .from('mined_patterns')
      .select('*')
      .eq('is_significant', true)
      .order('success_rate', { ascending: false })
      .limit(limit);

    if (!data) return [];

    return data.map((p: any) => ({
      name: p.pattern_name,
      type: p.pattern_type,
      conditions: p.conditions,
      timeframe: p.timeframe,
      occurrences: p.occurrence_count,
      successes: p.success_count,
      successRate: p.success_rate,
      avgReturn: p.avg_return,
      pValue: p.p_value,
      isSignificant: p.is_significant,
    }));
  }
}

// ============================================================
// Main Entry Point (runs hourly via cron)
// ============================================================

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Pattern Miner');
  console.log('='.repeat(50));

  const miner = new PatternMiner();

  // Initial run
  const patterns = await miner.minePatterns();

  console.log('[PatternMiner] Discovered patterns:');
  for (const p of patterns) {
    console.log(
      `  - ${p.name}: ${p.successRate.toFixed(1)}% (${p.occurrences} occurrences, p=${p.pValue?.toFixed(4)})`
    );
  }

  console.log(`[PatternMiner] Total: ${patterns.length} significant patterns`);

  // Daemon mode: check hourly and idle
  console.log(`[PatternMiner] Idling, will check again in 1 hour`);

  setInterval(async () => {
    try {
      console.log('='.repeat(50));
      console.log('[PatternMiner] Hourly pattern mining cycle');
      console.log('='.repeat(50));

      const patterns = await miner.minePatterns();
      console.log(`[PatternMiner] Total: ${patterns.length} significant patterns`);
    } catch (error) {
      console.error('[PatternMiner] Error in cycle:', error);
    }
  }, CHECK_INTERVAL_MS);
}

if (import.meta.main) {
  main().catch(console.error);
}
