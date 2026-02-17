/**
 * BEHEMOTH Trade Journal
 *
 * Records and analyzes trade performance:
 * - MFE/MAE tracking
 * - Setup quality scoring
 * - Pattern tagging
 * - Lessons learned
 */

import { createClient } from "@supabase/supabase-js";
import type { TradeExecution, TradeJournal } from '../utils/trading-types';

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ============================================================
// Trade Journal Class
// ============================================================

export class TradeJournalManager {
  /**
   * Create journal entry for a closed trade
   */
  async createJournalEntry(
    execution: TradeExecution,
    additionalData?: Partial<TradeJournal>
  ): Promise<TradeJournal | null> {
    if (!supabase || !execution.id) return null;

    // Determine trade type based on duration
    const tradeType = this.determineTradeType(execution.durationSeconds || 0);

    // Determine market condition (would need price data)
    const marketCondition = await this.determineMarketCondition(execution.symbol);

    // Determine session
    const session = this.determineSession(execution.openedAt);

    // Auto-score setup quality based on outcome
    const setupQuality = this.scoreSetupQuality(execution);
    const entryQuality = this.scoreEntryQuality(execution);
    const exitQuality = this.scoreExitQuality(execution);

    const journal: TradeJournal = {
      executionId: execution.id,
      tradeType,
      marketCondition,
      session,
      setupQuality,
      entryQuality,
      exitQuality,
      followedPlan: true,
      patternTags: [],
      ...additionalData,
    };

    try {
      const { data, error } = await supabase
        .from('trade_journal')
        .insert({
          execution_id: journal.executionId,
          trade_type: journal.tradeType,
          market_condition: journal.marketCondition,
          session: journal.session,
          setup_quality: journal.setupQuality,
          entry_quality: journal.entryQuality,
          exit_quality: journal.exitQuality,
          fomo_score: journal.fomoScore,
          revenge_trading: journal.revengeTrading,
          followed_plan: journal.followedPlan,
          what_worked: journal.whatWorked,
          what_didnt_work: journal.whatDidntWork,
          lesson_learned: journal.lessonLearned,
          improvement_action: journal.improvementAction,
          pattern_tags: journal.patternTags,
        })
        .select('id')
        .single();

      if (error) {
        console.error('[TradeJournal] Error creating entry:', error);
        return null;
      }

      console.log(`[TradeJournal] Created entry for trade ${execution.id}`);
      return journal;
    } catch (error) {
      console.error('[TradeJournal] Exception creating entry:', error);
      return null;
    }
  }

  /**
   * Update journal entry with lessons learned
   */
  async updateLessonsLearned(
    executionId: string,
    lessons: {
      whatWorked?: string;
      whatDidntWork?: string;
      lessonLearned?: string;
      improvementAction?: string;
    }
  ): Promise<void> {
    if (!supabase) return;

    await supabase
      .from('trade_journal')
      .update({
        what_worked: lessons.whatWorked,
        what_didnt_work: lessons.whatDidntWork,
        lesson_learned: lessons.lessonLearned,
        improvement_action: lessons.improvementAction,
        updated_at: new Date().toISOString(),
      })
      .eq('execution_id', executionId);
  }

  /**
   * Add pattern tags to a journal entry
   */
  async addPatternTags(executionId: string, tags: string[]): Promise<void> {
    if (!supabase) return;

    const { data } = await supabase
      .from('trade_journal')
      .select('pattern_tags')
      .eq('execution_id', executionId)
      .single();

    const existingTags = data?.pattern_tags || [];
    const newTags = [...new Set([...existingTags, ...tags])];

    await supabase
      .from('trade_journal')
      .update({ pattern_tags: newTags })
      .eq('execution_id', executionId);
  }

  /**
   * Get recent journal entries
   */
  async getRecentEntries(limit: number = 20): Promise<any[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
      .from('trade_journal')
      .select(`
        *,
        trade_executions (
          symbol,
          position_side,
          entry_price,
          exit_price,
          realized_pnl,
          realized_pnl_percent,
          mfe,
          mae
        )
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data;
  }

  /**
   * Get performance statistics
   */
  async getPerformanceStats(days: number = 30): Promise<{
    totalTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    avgMFE: number;
    avgMAE: number;
    bestSession: string;
    worstSession: string;
    avgSetupQuality: number;
    topPatterns: string[];
  }> {
    if (!supabase) {
      return {
        totalTrades: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        avgMFE: 0,
        avgMAE: 0,
        bestSession: '',
        worstSession: '',
        avgSetupQuality: 0,
        topPatterns: [],
      };
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data } = await supabase
      .from('trade_executions')
      .select(`
        id,
        realized_pnl,
        realized_pnl_percent,
        mfe,
        mae,
        trade_journal (
          session,
          setup_quality,
          pattern_tags
        )
      `)
      .eq('status', 'closed')
      .gte('closed_at', startDate.toISOString());

    if (!data || data.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        avgMFE: 0,
        avgMAE: 0,
        bestSession: '',
        worstSession: '',
        avgSetupQuality: 0,
        topPatterns: [],
      };
    }

    const wins = data.filter((t: any) => t.realized_pnl > 0);
    const losses = data.filter((t: any) => t.realized_pnl < 0);

    const totalWins = wins.reduce((sum: number, t: any) => sum + t.realized_pnl, 0);
    const totalLosses = Math.abs(
      losses.reduce((sum: number, t: any) => sum + t.realized_pnl, 0)
    );

    // Session performance
    const sessionPerf: Record<string, { wins: number; total: number }> = {};
    for (const trade of data) {
      const session = (trade.trade_journal as any)?.session || 'unknown';
      if (!sessionPerf[session]) {
        sessionPerf[session] = { wins: 0, total: 0 };
      }
      sessionPerf[session].total++;
      if (trade.realized_pnl > 0) {
        sessionPerf[session].wins++;
      }
    }

    let bestSession = '';
    let worstSession = '';
    let bestRate = -1;
    let worstRate = 101;

    for (const [session, perf] of Object.entries(sessionPerf)) {
      const rate = perf.wins / perf.total;
      if (rate > bestRate) {
        bestRate = rate;
        bestSession = session;
      }
      if (rate < worstRate) {
        worstRate = rate;
        worstSession = session;
      }
    }

    // Pattern frequency
    const patternCount: Record<string, number> = {};
    for (const trade of data) {
      const tags = (trade.trade_journal as any)?.pattern_tags || [];
      for (const tag of tags) {
        patternCount[tag] = (patternCount[tag] || 0) + 1;
      }
    }

    const topPatterns = Object.entries(patternCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);

    // Average setup quality
    const qualities = data
      .map((t: any) => (t.trade_journal as any)?.setup_quality)
      .filter((q): q is number => q != null);
    const avgSetupQuality = qualities.length > 0
      ? qualities.reduce((a, b) => a + b, 0) / qualities.length
      : 0;

    return {
      totalTrades: data.length,
      winRate: (wins.length / data.length) * 100,
      avgWin: wins.length > 0 ? totalWins / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
      profitFactor: totalLosses > 0 ? totalWins / totalLosses : 0,
      avgMFE: data.reduce((sum: number, t: any) => sum + (t.mfe || 0), 0) / data.length,
      avgMAE: data.reduce((sum: number, t: any) => sum + (t.mae || 0), 0) / data.length,
      bestSession,
      worstSession,
      avgSetupQuality,
      topPatterns,
    };
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  private determineTradeType(durationSeconds: number): TradeJournal['tradeType'] {
    if (durationSeconds < 300) return 'scalp'; // < 5 min
    if (durationSeconds < 3600) return 'day_trade'; // < 1 hour
    if (durationSeconds < 86400) return 'swing'; // < 1 day
    return 'position';
  }

  private async determineMarketCondition(
    symbol: string
  ): Promise<TradeJournal['marketCondition']> {
    // Would analyze recent price data
    // For now, return default
    return 'ranging';
  }

  private determineSession(timestamp?: Date): TradeJournal['session'] {
    if (!timestamp) return 'new_york';

    const hour = timestamp.getUTCHours();

    // Asian: 0-8 UTC
    // London: 7-16 UTC
    // New York: 12-21 UTC
    // Overlap: 12-16 UTC

    if (hour >= 12 && hour < 16) return 'overlap';
    if (hour >= 0 && hour < 8) return 'asian';
    if (hour >= 7 && hour < 16) return 'london';
    return 'new_york';
  }

  private scoreSetupQuality(execution: TradeExecution): number {
    // Score based on:
    // - Did it hit TP? (high quality)
    // - What was MFE? (missed opportunity)
    // - What was MAE? (bad entry timing)

    if (!execution.mfe || !execution.mae) return 3;

    let score = 3; // Baseline

    // Good if MFE was high
    if (execution.mfe > 3) score += 1;
    if (execution.mfe > 5) score += 1;

    // Bad if MAE was high (bad entry)
    if (execution.mae < -2) score -= 1;
    if (execution.mae < -3) score -= 1;

    // Win bonus
    if (execution.realizedPnl > 0) score += 0.5;

    return Math.max(1, Math.min(5, Math.round(score)));
  }

  private scoreEntryQuality(execution: TradeExecution): number {
    // Score based on MAE (how far against us did it go)
    if (!execution.mae) return 3;

    if (execution.mae >= -0.5) return 5; // Perfect entry
    if (execution.mae >= -1) return 4; // Good entry
    if (execution.mae >= -2) return 3; // OK entry
    if (execution.mae >= -3) return 2; // Bad entry
    return 1; // Terrible entry
  }

  private scoreExitQuality(execution: TradeExecution): number {
    // Score based on MFE vs realized (how much did we leave on table)
    if (!execution.mfe || !execution.realizedPnlPercent) return 3;

    // For winning trades
    if (execution.realizedPnlPercent > 0) {
      const captureRatio = execution.realizedPnlPercent / execution.mfe;
      if (captureRatio > 0.8) return 5; // Captured 80%+ of move
      if (captureRatio > 0.6) return 4;
      if (captureRatio > 0.4) return 3;
      return 2;
    }

    // For losing trades
    return execution.mae && execution.mae > -2 ? 3 : 2;
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Trade Journal');
  console.log('='.repeat(50));

  const journal = new TradeJournalManager();

  const stats = await journal.getPerformanceStats(30);
  console.log('[TradeJournal] Performance stats:', stats);
}

if (import.meta.main) {
  main().catch(console.error);
}
