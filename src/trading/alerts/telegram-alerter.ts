/**
 * BEHEMOTH Telegram Alerter
 *
 * Sends trading alerts to Telegram:
 * - Trade notifications
 * - Risk warnings
 * - Performance summaries
 */

import { createClient } from "@supabase/supabase-js";
import type { Alert, TradeExecution, AlertSeverity } from '../utils/trading-types';

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ============================================================
// Telegram Alerter Class
// ============================================================

export class TelegramAlerter {
  private botToken: string;
  private userId: string;
  private realtimeSubscription: any = null;

  constructor(botToken?: string, userId?: string) {
    this.botToken = botToken || TELEGRAM_BOT_TOKEN;
    this.userId = userId || TELEGRAM_USER_ID;
  }

  /**
   * Start listening for alerts via Supabase realtime
   */
  async startRealtime(): Promise<void> {
    if (!supabase) {
      console.log('[TelegramAlerter] Supabase not configured');
      return;
    }

    console.log('[TelegramAlerter] Starting realtime listener');

    this.realtimeSubscription = supabase
      .channel('alerts-channel')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'alerts',
        },
        (payload) => {
          this.handleNewAlert(payload.new as any);
        }
      )
      .subscribe();
  }

  /**
   * Stop realtime listener
   */
  stopRealtime(): void {
    if (this.realtimeSubscription) {
      this.realtimeSubscription.unsubscribe();
      this.realtimeSubscription = null;
    }
  }

  /**
   * Handle new alert from realtime
   */
  private async handleNewAlert(alert: any): Promise<void> {
    // Skip if already sent
    if (alert.telegram_sent) return;

    // Format and send message
    const message = this.formatAlertMessage(alert);
    const success = await this.sendMessage(message);

    // Mark as sent
    if (success && supabase) {
      await supabase
        .from('alerts')
        .update({
          telegram_sent: true,
          telegram_sent_at: new Date().toISOString(),
        })
        .eq('id', alert.id);
    }

    // Trigger voice alert if needed
    if (alert.voice_alert && alert.voice_message) {
      await this.sendVoiceAlert(alert.voice_message);
    }
  }

  /**
   * Format alert message for Telegram
   */
  private formatAlertMessage(alert: any): string {
    const severityEmoji: Record<AlertSeverity, string> = {
      info: '📊',
      warning: '⚠️',
      critical: '🚨',
      emergency: '🆘',
    };

    const emoji = severityEmoji[alert.severity] || '📢';

    let message = `${emoji} <b>${alert.title}</b>\n\n`;
    message += `${alert.message}\n`;

    // Add symbol if present
    if (alert.symbol) {
      message += `\n💰 Symbol: <code>${alert.symbol}</code>`;
    }

    // Add timestamp
    const time = new Date(alert.created_at).toLocaleTimeString();
    message += `\n🕐 ${time}`;

    return message;
  }

  /**
   * Send message to Telegram
   */
  async sendMessage(message: string, parseMode: string = 'HTML'): Promise<boolean> {
    if (!this.botToken || !this.userId) {
      console.log('[TelegramAlerter] Bot token or user ID not configured');
      return false;
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.userId,
            text: message,
            parse_mode: parseMode,
            disable_notification: false,
          }),
        }
      );

      const data = await response.json();

      if (!data.ok) {
        console.error('[TelegramAlerter] Send error:', data.description);
        return false;
      }

      return true;
    } catch (error) {
      console.error('[TelegramAlerter] Exception sending message:', error);
      return false;
    }
  }

  /**
   * Send trade opened notification
   */
  async sendTradeOpenedAlert(execution: TradeExecution): Promise<void> {
    const message = this.formatTradeOpenedMessage(execution);
    await this.sendMessage(message);
  }

  /**
   * Send trade closed notification
   */
  async sendTradeClosedAlert(execution: TradeExecution): Promise<void> {
    const message = this.formatTradeClosedMessage(execution);
    await this.sendMessage(message);
  }

  /**
   * Format trade opened message
   */
  private formatTradeOpenedMessage(execution: TradeExecution): string {
    const sideEmoji = execution.positionSide === 'long' ? '🟢' : '🔴';

    let message = `${sideEmoji} <b>Opened ${execution.positionSide.toUpperCase()}</b>\n\n`;
    message += `💰 <b>${execution.symbol}</b>\n`;
    message += `📍 Entry: <code>$${execution.entryPrice.toFixed(2)}</code>\n`;
    message += `📐 Size: <code>$${execution.positionSizeUsd.toFixed(2)}</code>\n`;
    message += `⚡ Leverage: <code>${execution.leverage}x</code>\n`;

    if (execution.stopLossPrice) {
      message += `🛑 Stop: <code>$${execution.stopLossPrice.toFixed(2)}</code>\n`;
    }

    if (execution.takeProfitPrice) {
      message += `🎯 TP: <code>$${execution.takeProfitPrice.toFixed(2)}</code>\n`;
    }

    return message;
  }

  /**
   * Format trade closed message
   */
  private formatTradeClosedMessage(execution: TradeExecution): string {
    const isWin = execution.realizedPnl > 0;
    const emoji = isWin ? '✅' : '❌';

    let message = `${emoji} <b>Closed ${execution.symbol}</b>\n\n`;
    message += `📍 Entry: <code>$${execution.entryPrice.toFixed(2)}</code>\n`;

    if (execution.exitPrice) {
      message += `🏁 Exit: <code>$${execution.exitPrice.toFixed(2)}</code>\n`;
    }

    const pnlSign = execution.realizedPnl >= 0 ? '+' : '';
    message += `📊 P&L: <code>${pnlSign}${execution.realizedPnlPercent.toFixed(2)}%</code>\n`;
    message += `💵 P&L: <code>${pnlSign}$${execution.realizedPnl.toFixed(2)}</code>\n`;

    if (execution.durationSeconds) {
      const mins = Math.floor(execution.durationSeconds / 60);
      const secs = execution.durationSeconds % 60;
      message += `⏱ Duration: <code>${mins}m ${secs}s</code>\n`;
    }

    if (execution.closeReason) {
      message += `📝 Reason: <code>${execution.closeReason}</code>\n`;
    }

    return message;
  }

  /**
   * Send balance update
   */
  async sendBalanceAlert(balance: { currency: string; total: number; free: number }[]): Promise<void> {
    let message = '💰 <b>Account Balance</b>\n\n';

    for (const b of balance) {
      message += `<b>${b.currency}</b>\n`;
      message += `  Total: <code>$${b.total.toFixed(2)}</code>\n`;
      message += `  Available: <code>$${b.free.toFixed(2)}</code>\n\n`;
    }

    await this.sendMessage(message);
  }

  /**
   * Send daily performance summary
   */
  async sendDailyPerformance(stats: {
    trades: number;
    wins: number;
    losses: number;
    pnl: number;
    pnlPercent: number;
  }): Promise<void> {
    const emoji = stats.pnl >= 0 ? '📈' : '📉';

    let message = `${emoji} <b>Daily Performance</b>\n\n`;
    message += `📊 Trades: <code>${stats.trades}</code>\n`;
    message += `✅ Wins: <code>${stats.wins}</code>\n`;
    message += `❌ Losses: <code>${stats.losses}</code>\n`;

    const winRate = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0';
    message += `🎯 Win Rate: <code>${winRate}%</code>\n`;

    const pnlSign = stats.pnl >= 0 ? '+' : '';
    message += `💵 P&L: <code>${pnlSign}$${stats.pnl.toFixed(2)}</code>\n`;
    message += `📊 P&L%: <code>${pnlSign}${stats.pnlPercent.toFixed(2)}%</code>\n`;

    await this.sendMessage(message);
  }

  /**
   * Send emergency alert
   */
  async sendEmergencyAlert(reason: string): Promise<void> {
    const message = `🆘 <b>EMERGENCY STOP</b>\n\n${reason}\n\n⚠️ All positions closed.\n🚫 Trading halted for 24 hours.`;
    await this.sendMessage(message);
  }

  /**
   * Send risk warning
   */
  async sendRiskWarning(type: string, message: string): Promise<void> {
    const alert = `⚠️ <b>Risk Warning: ${type}</b>\n\n${message}`;
    await this.sendMessage(alert);
  }

  /**
   * Trigger voice alert (delegates to voice-responder)
   */
  private async sendVoiceAlert(message: string): Promise<void> {
    // This would call the voice responder module
    // For now, just log it
    console.log(`[TelegramAlerter] Voice alert: ${message}`);
  }
}

// ============================================================
// Command Handlers
// ============================================================

export class TradingCommands {
  private alerter: TelegramAlerter;

  constructor(alerter: TelegramAlerter) {
    this.alerter = alerter;
  }

  /**
   * Format /trades response
   */
  async formatTradesCommand(limit: number = 5): Promise<string> {
    if (!supabase) return 'Database not configured';

    const { data } = await supabase
      .from('trade_executions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!data || data.length === 0) {
      return 'No recent trades';
    }

    let message = '📊 <b>Recent Trades</b>\n\n';

    for (const trade of data) {
      const emoji = trade.realized_pnl > 0 ? '✅' : trade.realized_pnl < 0 ? '❌' : '⏳';
      const status = trade.status === 'open' ? '🟢' : '';

      message += `${emoji} ${status} <b>${trade.symbol}</b> ${trade.position_side}\n`;
      message += `   Entry: $${trade.entry_price.toFixed(2)}`;

      if (trade.exit_price) {
        message += ` → Exit: $${trade.exit_price.toFixed(2)}`;
      }

      if (trade.realized_pnl_percent) {
        const sign = trade.realized_pnl_percent >= 0 ? '+' : '';
        message += ` | ${sign}${trade.realized_pnl_percent.toFixed(2)}%`;
      }

      message += '\n';
    }

    return message;
  }

  /**
   * Format /balance response
   */
  async formatBalanceCommand(): Promise<string> {
    // This would get actual balance from TradeExecutor
    return '💰 Use /balance to check account balance (requires executor)';
  }

  /**
   * Format /signals response
   */
  async formatSignalsCommand(): Promise<string> {
    if (!supabase) return 'Database not configured';

    const { data } = await supabase
      .from('active_signals_view')
      .select('*')
      .limit(5);

    if (!data || data.length === 0) {
      return 'No active signals';
    }

    let message = '📡 <b>Active Signals</b>\n\n';

    for (const signal of data) {
      const emoji = signal.signal_type === 'long' ? '🟢' : '🔴';

      message += `${emoji} <b>${signal.symbol}</b> ${signal.signal_type.toUpperCase()}\n`;
      message += `   Entry: $${signal.entry_price.toFixed(2)}\n`;
      message += `   Confidence: ${signal.confidence.toFixed(1)}%\n`;
      message += `   TTL: ${Math.max(0, Math.floor(signal.ttl_seconds || 0))}s\n\n`;
    }

    return message;
  }

  /**
   * Format /risk response
   */
  async formatRiskCommand(): Promise<string> {
    if (!supabase) return 'Database not configured';

    const { data } = await supabase
      .from('risk_dashboard_view')
      .select('*')
      .limit(1)
      .single();

    if (!data) {
      return 'No risk data available';
    }

    let message = '🛡️ <b>Risk Dashboard</b>\n\n';
    message += `📊 Daily P&L: ${data.daily_pnl_percent?.toFixed(2) || '0'}%\n`;
    message += `📉 Drawdown: ${data.current_drawdown?.toFixed(2) || '0'}%\n`;
    message += `📐 Open Positions: ${data.open_positions || 0}\n`;
    message += `💰 Balance: $${data.total_balance_usd?.toFixed(2) || '0'}\n`;
    message += `📈 Equity: $${data.equity_usd?.toFixed(2) || '0'}\n`;
    message += `🎯 Win Rate: ${data.daily_win_rate?.toFixed(1) || '0'}%\n`;
    message += `\n`;

    if (data.emergency_stop_triggered) {
      message += '🚨 EMERGENCY STOP ACTIVE\n';
    } else if (data.trading_enabled) {
      message += '✅ Trading Enabled';
    } else {
      message += '⏸️ Trading Paused';
    }

    return message;
  }

  /**
   * Format /performance response
   */
  async formatPerformanceCommand(): Promise<string> {
    if (!supabase) return 'Database not configured';

    const { data } = await supabase
      .from('strategy_performance')
      .select('*')
      .eq('period_type', 'all_time')
      .order('total_trades', { ascending: false })
      .limit(1)
      .single();

    if (!data) {
      return 'No performance data available';
    }

    let message = '📈 <b>All-Time Performance</b>\n\n';
    message += `📊 Total Trades: ${data.total_trades}\n`;
    message += `✅ Wins: ${data.winning_trades}\n`;
    message += `❌ Losses: ${data.losing_trades}\n`;
    message += `🎯 Win Rate: ${data.win_rate?.toFixed(1)}%\n`;
    message += `💰 Total P&L: $${data.total_pnl?.toFixed(2) || '0'}\n`;
    message += `📉 Max Drawdown: ${data.max_drawdown?.toFixed(2) || '0'}%\n`;
    message += `⚡ Sharpe: ${data.sharpe_ratio?.toFixed(2) || 'N/A'}\n`;

    return message;
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Telegram Alerter');
  console.log('='.repeat(50));

  const alerter = new TelegramAlerter();

  // Start realtime listener
  await alerter.startRealtime();

  // Handle shutdown
  process.on('SIGINT', () => {
    alerter.stopRealtime();
    process.exit(0);
  });

  console.log('[TelegramAlerter] Listening for alerts...');
}

if (import.meta.main) {
  main().catch(console.error);
}
