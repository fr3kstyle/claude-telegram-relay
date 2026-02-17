/**
 * BEHEMOTH Risk Manager
 *
 * Real-time risk monitoring and management:
 * - Position limits
 * - Drawdown tracking
 * - Daily loss limits
 * - Emergency stop
 */

import { createClient } from "@supabase/supabase-js";
import type { RiskMetrics, RiskCheckResult, TradeExecution } from '../utils/trading-types';
import { TradeExecutor } from './trade-executor';

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// Default risk limits
const DEFAULT_LIMITS = {
  dailyLossLimit: 15, // 15% daily loss limit
  maxDrawdown: 30, // 30% max drawdown
  maxPositions: 2, // Max concurrent positions
  maxPositionSizePercent: 5, // 5% per position
  emergencyStopThreshold: 35, // 35% triggers 24h halt
};

// ============================================================
// Risk Manager Class
// ============================================================

export class RiskManager {
  private executor: TradeExecutor;
  private limits: typeof DEFAULT_LIMITS;
  private checkInterval: Timer | null = null;
  private isRunning: boolean = false;

  constructor(executor: TradeExecutor, customLimits?: Partial<typeof DEFAULT_LIMITS>) {
    this.executor = executor;
    this.limits = { ...DEFAULT_LIMITS, ...customLimits };
  }

  /**
   * Start risk monitoring loop
   */
  async start(intervalMs: number = 10000): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log('[RiskManager] Starting risk monitor');

    // Initial check
    await this.runRiskCheck();

    // Schedule periodic checks
    this.checkInterval = setInterval(() => this.runRiskCheck(), intervalMs);
  }

  /**
   * Stop risk monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    console.log('[RiskManager] Stopped');
  }

  /**
   * Run a single risk check
   */
  async runRiskCheck(): Promise<void> {
    try {
      const metrics = await this.getRiskMetrics();
      const positions = await this.executor.getPositions();

      // Check drawdown
      if (metrics.currentDrawdown >= this.limits.maxDrawdown) {
        await this.handleMaxDrawdown(metrics);
      }

      // Check daily loss limit
      if (metrics.dailyPnlPercent <= -this.limits.dailyLossLimit) {
        await this.handleDailyLossLimit(metrics);
      }

      // Check position count
      if (positions.length > this.limits.maxPositions) {
        console.warn('[RiskManager] Too many positions, should not open more');
      }

      // Update metrics in database
      await this.updateRiskMetrics(metrics, positions);
    } catch (error) {
      console.error('[RiskManager] Risk check error:', error);
    }
  }

  /**
   * Check if trading is allowed
   */
  async canTrade(amount: number): Promise<RiskCheckResult> {
    const warnings: string[] = [];

    // Get current state
    const metrics = await this.getRiskMetrics();
    const positions = await this.executor.getPositions();

    // Check emergency stop
    if (metrics.emergencyStopTriggered) {
      if (metrics.tradingPausedUntil && new Date(metrics.tradingPausedUntil) > new Date()) {
        return {
          allowed: false,
          reason: 'Emergency stop active until ' + metrics.tradingPausedUntil,
          warnings: ['Trading halted due to emergency stop'],
        };
      }
    }

    // Check if trading enabled
    if (!metrics.tradingEnabled) {
      return {
        allowed: false,
        reason: 'Trading is currently disabled',
        warnings,
      };
    }

    // Check daily loss limit
    if (metrics.dailyPnlPercent <= -this.limits.dailyLossLimit) {
      return {
        allowed: false,
        reason: `Daily loss limit reached (${metrics.dailyPnlPercent.toFixed(2)}%)`,
        warnings,
      };
    }

    // Check max drawdown
    if (metrics.currentDrawdown >= this.limits.maxDrawdown) {
      return {
        allowed: false,
        reason: `Max drawdown reached (${metrics.currentDrawdown.toFixed(2)}%)`,
        warnings,
      };
    }

    // Check position count
    if (positions.length >= this.limits.maxPositions) {
      return {
        allowed: false,
        reason: `Max positions reached (${this.limits.maxPositions})`,
        warnings,
      };
    }

    // Check position size
    if (amount > this.limits.maxPositionSizePercent) {
      warnings.push(`Position size ${amount.toFixed(2)}% exceeds recommended ${this.limits.maxPositionSizePercent}%`);
    }

    // Warn on approaching limits
    if (metrics.dailyPnlPercent <= -this.limits.dailyLossLimit * 0.7) {
      warnings.push(`Approaching daily loss limit: ${metrics.dailyPnlPercent.toFixed(2)}%`);
    }

    if (metrics.currentDrawdown >= this.limits.maxDrawdown * 0.7) {
      warnings.push(`Approaching max drawdown: ${metrics.currentDrawdown.toFixed(2)}%`);
    }

    return {
      allowed: true,
      reason: 'OK',
      warnings,
    };
  }

  /**
   * Get current risk metrics
   */
  async getRiskMetrics(): Promise<RiskMetrics> {
    // Try to get from database first
    if (supabase) {
      const { data } = await supabase
        .from('risk_metrics')
        .select('*')
        .eq('trading_date', new Date().toISOString().split('T')[0])
        .single();

      if (data) {
        return {
          tradingDate: new Date(data.trading_date),
          dailyPnl: data.daily_pnl,
          dailyPnlPercent: data.daily_pnl_percent,
          dailyTrades: data.daily_trades,
          dailyWins: data.daily_wins,
          dailyLosses: data.daily_losses,
          dailyWinRate: data.daily_win_rate,
          currentDrawdown: data.current_drawdown,
          maxDrawdown: data.max_drawdown,
          openPositions: data.open_positions,
          totalExposureUsd: data.total_exposure_usd,
          maxSingleExposureUsd: data.max_single_exposure_usd,
          currentLeverageAvg: data.current_leverage_avg,
          maxLeverageUsed: data.max_leverage_used,
          dailyLossLimit: data.daily_loss_limit,
          maxDrawdownLimit: data.max_drawdown_limit,
          maxPositions: data.max_positions,
          maxPositionSizePercent: data.max_position_size_percent,
          emergencyStopTriggered: data.emergency_stop_triggered,
          tradingEnabled: data.trading_enabled,
          tradingPausedUntil: data.trading_paused_until ? new Date(data.trading_paused_until) : undefined,
        };
      }
    }

    // Return defaults
    return {
      tradingDate: new Date(),
      dailyPnl: 0,
      dailyPnlPercent: 0,
      dailyTrades: 0,
      dailyWins: 0,
      dailyLosses: 0,
      dailyWinRate: 0,
      currentDrawdown: 0,
      maxDrawdown: 0,
      openPositions: 0,
      totalExposureUsd: 0,
      maxSingleExposureUsd: 0,
      currentLeverageAvg: 0,
      maxLeverageUsed: 0,
      dailyLossLimit: this.limits.dailyLossLimit,
      maxDrawdownLimit: this.limits.maxDrawdown,
      maxPositions: this.limits.maxPositions,
      maxPositionSizePercent: this.limits.maxPositionSizePercent,
      emergencyStopTriggered: false,
      tradingEnabled: true,
    };
  }

  /**
   * Trigger emergency stop
   */
  async triggerEmergencyStop(reason: string = 'Manual trigger'): Promise<void> {
    console.log('[RiskManager] EMERGENCY STOP TRIGGERED:', reason);

    // Close all positions
    const closedCount = await this.executor.emergencyCloseAll();
    console.log(`[RiskManager] Closed ${closedCount} positions`);

    // Update database
    if (supabase) {
      await supabase.rpc('trigger_emergency_stop', { p_reason: reason });
    }

    // Create alert
    if (supabase) {
      await supabase.from('alerts').insert({
        alert_type: 'emergency_stop',
        severity: 'emergency',
        title: 'EMERGENCY STOP ACTIVATED',
        message: reason,
        voice_alert: true,
        voice_message: 'Emergency stop activated. All positions closed. Trading halted for 24 hours.',
      });
    }
  }

  /**
   * Clear emergency stop
   */
  async clearEmergencyStop(): Promise<void> {
    console.log('[RiskManager] Clearing emergency stop');

    if (supabase) {
      await supabase.rpc('clear_emergency_stop');
    }
  }

  /**
   * Update trade statistics after a trade
   */
  async recordTradeResult(execution: TradeExecution): Promise<void> {
    const isWin = execution.realizedPnl > 0;

    if (supabase) {
      await supabase.rpc('update_risk_after_trade', {
        p_pnl: execution.realizedPnl,
        p_is_win: isWin,
      });
    }

    // Check if we hit emergency threshold
    const metrics = await this.getRiskMetrics();
    if (metrics.dailyPnlPercent <= -this.limits.emergencyStopThreshold) {
      await this.triggerEmergencyStop('Emergency stop threshold reached');
    }
  }

  /**
   * Handle max drawdown reached
   */
  private async handleMaxDrawdown(metrics: RiskMetrics): Promise<void> {
    console.warn('[RiskManager] MAX DRAWDOWN REACHED:', metrics.currentDrawdown);

    if (supabase) {
      await supabase.from('alerts').insert({
        alert_type: 'drawdown_critical',
        severity: 'critical',
        title: 'MAX DRAWDOWN REACHED',
        message: `Current drawdown: ${metrics.currentDrawdown.toFixed(2)}%`,
        voice_alert: true,
        voice_message: `Maximum drawdown of ${metrics.currentDrawdown.toFixed(1)} percent reached. Consider reducing exposure.`,
      });
    }

    // Disable trading
    if (supabase) {
      await supabase
        .from('risk_metrics')
        .update({ trading_enabled: false })
        .eq('trading_date', new Date().toISOString().split('T')[0]);
    }
  }

  /**
   * Handle daily loss limit reached
   */
  private async handleDailyLossLimit(metrics: RiskMetrics): Promise<void> {
    console.warn('[RiskManager] DAILY LOSS LIMIT REACHED:', metrics.dailyPnlPercent);

    if (supabase) {
      await supabase.from('alerts').insert({
        alert_type: 'daily_loss_limit',
        severity: 'warning',
        title: 'DAILY LOSS LIMIT REACHED',
        message: `Daily P&L: ${metrics.dailyPnlPercent.toFixed(2)}%`,
        voice_alert: true,
        voice_message: `Daily loss limit reached at ${metrics.dailyPnlPercent.toFixed(1)} percent. No more trades today.`,
      });
    }

    // Disable trading for rest of day
    if (supabase) {
      await supabase
        .from('risk_metrics')
        .update({ trading_enabled: false })
        .eq('trading_date', new Date().toISOString().split('T')[0]);
    }
  }

  /**
   * Update risk metrics in database
   */
  private async updateRiskMetrics(
    metrics: RiskMetrics,
    positions: any[]
  ): Promise<void> {
    if (!supabase) return;

    const totalExposure = positions.reduce((sum, p) => sum + Math.abs(p.size * p.entryPrice), 0);
    const avgLeverage = positions.length > 0
      ? positions.reduce((sum, p) => sum + p.leverage, 0) / positions.length
      : 0;
    const maxLeverage = positions.length > 0
      ? Math.max(...positions.map(p => p.leverage))
      : 0;

    await supabase
      .from('risk_metrics')
      .update({
        open_positions: positions.length,
        total_exposure_usd: totalExposure,
        current_leverage_avg: avgLeverage,
        max_leverage_used: maxLeverage,
        updated_at: new Date().toISOString(),
      })
      .eq('trading_date', new Date().toISOString().split('T')[0]);
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Risk Manager');
  console.log('='.repeat(50));

  const executor = new TradeExecutor();
  const riskManager = new RiskManager(executor);

  // Check if we can trade
  const canTrade = await riskManager.canTrade(5);
  console.log('[RiskManager] Can trade:', canTrade);

  // Get current metrics
  const metrics = await riskManager.getRiskMetrics();
  console.log('[RiskManager] Metrics:', metrics);

  // Start monitoring
  await riskManager.start(10000);

  // Handle shutdown
  process.on('SIGINT', () => {
    riskManager.stop();
    process.exit(0);
  });
}

if (import.meta.main) {
  main().catch(console.error);
}
