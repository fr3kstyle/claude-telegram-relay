/**
 * BEHEMOTH Paper Trade Executor
 *
 * PAPER TRADING MODE - NO REAL TRADES
 * - Receives signals from scanners
 * - Records hypothetical trades to database
 * - Tracks simulated P&L
 * - Learning from "paper" results
 */

import { createClient } from "@supabase/supabase-js";
import type { TradingSignal, Side } from '../utils/trading-types';

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ============================================================
// Paper Position Tracking
// ============================================================

interface PaperPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  size: number;
  leverage: number;
  openedAt: Date;
  stopLoss: number;
  takeProfit: number;
  signalId: string;
}

interface PaperTrade {
  id: string;
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
  openedAt: Date;
  closedAt: Date;
  marketConditions: {
    trend: string;
    volatility: string;
    volume: string;
  };
}

// In-memory position tracking
const openPositions = new Map<string, PaperPosition>();
const completedTrades: PaperTrade[] = [];

// Configuration
const DEFAULT_LEVERAGE = 10;
const DEFAULT_POSITION_SIZE_USD = 50;
const STOP_LOSS_PERCENT = 3;
const TAKE_PROFIT_PERCENT = 6;

// ============================================================
// Paper Trade Executor
// ============================================================

class PaperTradeExecutor {
  private running = false;
  private checkInterval: Timer | null = null;

  async start() {
    console.log('='.repeat(50));
    console.log('BEHEMOTH Paper Trade Executor');
    console.log('='.repeat(50));
    console.log('[PAPER] *** PAPER TRADING MODE ***');
    console.log('[PAPER] No real trades will be executed');
    console.log('[PAPER] All trades are simulated for learning');
    console.log('');

    this.running = true;

    // Load existing paper positions from DB
    await this.loadPositions();

    // Start monitoring loop
    this.checkInterval = setInterval(() => this.tick(), 10000); // Every 10s

    console.log('[PAPER] Executor started - monitoring for signals...');
  }

  async stop() {
    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    console.log('[PAPER] Executor stopped');
  }

  private async tick() {
    if (!this.running) return;

    try {
      // 1. Check for new signals to "execute"
      await this.checkForSignals();

      // 2. Update paper positions with current prices
      await this.updatePositionPrices();

      // 3. Check stop-losses and take-profits
      await this.checkExits();

      // 4. Log paper P&L summary
      this.logSummary();
    } catch (error) {
      console.error('[PAPER] Tick error:', error);
    }
  }

  /**
   * Load existing paper positions from database
   */
  private async loadPositions() {
    if (!supabase) return;

    try {
      const { data, error } = await supabase
        .from('paper_positions')
        .select('*')
        .eq('status', 'open');

      if (error) {
        console.log('[PAPER] No existing positions table - will create on first trade');
        return;
      }

      if (data) {
        for (const pos of data) {
          openPositions.set(pos.symbol, {
            symbol: pos.symbol,
            side: pos.side,
            entryPrice: pos.entry_price,
            size: pos.size,
            leverage: pos.leverage,
            openedAt: new Date(pos.opened_at),
            stopLoss: pos.stop_loss,
            takeProfit: pos.take_profit,
            signalId: pos.signal_id,
          });
        }
        console.log(`[PAPER] Loaded ${data.length} open positions`);
      }
    } catch (error) {
      console.error('[PAPER] Load positions error:', error);
    }
  }

  /**
   * Check for new signals to paper trade
   */
  private async checkForSignals() {
    if (!supabase) return;

    try {
      // Get unprocessed signals from last 5 minutes
      const { data: signals, error } = await supabase
        .from('trading_signals')
        .select('*')
        .gte('created_at', new Date(Date.now() - 5 * 60000).toISOString())
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(5);

      if (error || !signals || signals.length === 0) return;

      for (const signal of signals) {
        // Check if we already have a position for this symbol
        if (openPositions.has(signal.symbol)) {
          console.log(`[PAPER] ${signal.symbol}: Already have position, skipping signal`);
          continue;
        }

        // Execute paper trade
        await this.executePaperTrade(signal);

        // Mark signal as processed
        await supabase
          .from('trading_signals')
          .update({ status: 'paper_executed' })
          .eq('id', signal.id);
      }
    } catch (error) {
      console.error('[PAPER] Signal check error:', error);
    }
  }

  /**
   * Execute a paper trade
   */
  private async executePaperTrade(signal: any) {
    const side = signal.signal_type as 'long' | 'short';
    const entryPrice = signal.entry_price;
    const size = DEFAULT_POSITION_SIZE_USD / entryPrice;

    // Calculate stop loss and take profit
    let stopLoss: number, takeProfit: number;
    if (side === 'long') {
      stopLoss = entryPrice * (1 - STOP_LOSS_PERCENT / 100);
      takeProfit = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
    } else {
      stopLoss = entryPrice * (1 + STOP_LOSS_PERCENT / 100);
      takeProfit = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
    }

    const position: PaperPosition = {
      symbol: signal.symbol,
      side,
      entryPrice,
      size,
      leverage: DEFAULT_LEVERAGE,
      openedAt: new Date(),
      stopLoss,
      takeProfit,
      signalId: signal.id,
    };

    // Store in memory
    openPositions.set(signal.symbol, position);

    // Store in database
    if (supabase) {
      try {
        await supabase.from('paper_positions').insert({
          symbol: position.symbol,
          side: position.side,
          entry_price: position.entryPrice,
          size: position.size,
          leverage: position.leverage,
          opened_at: position.openedAt.toISOString(),
          stop_loss: position.stopLoss,
          take_profit: position.takeProfit,
          signal_id: position.signalId,
          status: 'open',
        });
      } catch (error) {
        // Table might not exist, that's ok for now
      }
    }

    console.log('');
    console.log('==================================================');
    console.log(`[PAPER] *** NEW PAPER TRADE ***`);
    console.log(`[PAPER] ${side.toUpperCase()} ${signal.symbol}`);
    console.log(`[PAPER] Entry: $${entryPrice.toFixed(6)}`);
    console.log(`[PAPER] Size: ${size.toFixed(4)} ($${DEFAULT_POSITION_SIZE_USD})`);
    console.log(`[PAPER] Leverage: ${DEFAULT_LEVERAGE}x`);
    console.log(`[PAPER] Stop Loss: $${stopLoss.toFixed(6)} (-${STOP_LOSS_PERCENT}%)`);
    console.log(`[PAPER] Take Profit: $${takeProfit.toFixed(6)} (+${TAKE_PROFIT_PERCENT}%)`);
    console.log(`[PAPER] Confidence: ${signal.confidence?.toFixed(0) || 'N/A'}%`);
    console.log('==================================================');
    console.log('');
  }

  /**
   * Update positions with current prices
   */
  private async updatePositionPrices() {
    for (const [symbol, position] of openPositions) {
      try {
        const res = await fetch(
          `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
        );
        if (!res.ok) continue;

        const data = await res.json();
        const ticker = data.result?.list?.[0];
        if (!ticker) continue;

        const currentPrice = parseFloat(ticker.lastPrice);

        // Calculate unrealized P&L
        let pnlPercent: number;
        if (position.side === 'long') {
          pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        } else {
          pnlPercent = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
        }

        const leveragePnl = pnlPercent * position.leverage;

        // Log significant moves
        if (Math.abs(leveragePnl) > 5) {
          console.log(`[PAPER] ${symbol}: ${leveragePnl > 0 ? '+' : ''}${leveragePnl.toFixed(2)}% (unrealized)`);
        }
      } catch (error) {
        // Ignore price fetch errors
      }
    }
  }

  /**
   * Check for stop-loss or take-profit hits
   */
  private async checkExits() {
    for (const [symbol, position] of openPositions) {
      try {
        const res = await fetch(
          `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
        );
        if (!res.ok) continue;

        const data = await res.json();
        const ticker = data.result?.list?.[0];
        if (!ticker) continue;

        const currentPrice = parseFloat(ticker.lastPrice);
        let shouldExit = false;
        let exitReason = '';

        // Check stop-loss
        if (position.side === 'long' && currentPrice <= position.stopLoss) {
          shouldExit = true;
          exitReason = 'Stop-loss hit';
        } else if (position.side === 'short' && currentPrice >= position.stopLoss) {
          shouldExit = true;
          exitReason = 'Stop-loss hit';
        }

        // Check take-profit
        if (position.side === 'long' && currentPrice >= position.takeProfit) {
          shouldExit = true;
          exitReason = 'Take-profit hit';
        } else if (position.side === 'short' && currentPrice <= position.takeProfit) {
          shouldExit = true;
          exitReason = 'Take-profit hit';
        }

        if (shouldExit) {
          await this.closePaperTrade(position, currentPrice, exitReason);
        }
      } catch (error) {
        // Ignore errors
      }
    }
  }

  /**
   * Close a paper trade and record results
   */
  private async closePaperTrade(position: PaperPosition, exitPrice: number, reason: string) {
    // Calculate P&L
    let pnlPercent: number;
    if (position.side === 'long') {
      pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    } else {
      pnlPercent = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
    }

    const leveragePnl = pnlPercent * position.leverage;
    const pnlUsd = DEFAULT_POSITION_SIZE_USD * (leveragePnl / 100);

    const trade: PaperTrade = {
      id: `${position.symbol}-${Date.now()}`,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      size: position.size,
      leverage: position.leverage,
      pnl: pnlUsd,
      pnlPercent: leveragePnl,
      entryReason: 'Signal from scanner',
      exitReason: reason,
      signalConfidence: 70, // Would get from signal
      openedAt: position.openedAt,
      closedAt: new Date(),
      marketConditions: {
        trend: 'unknown',
        volatility: 'medium',
        volume: 'normal',
      },
    };

    // Remove from open positions
    openPositions.delete(position.symbol);

    // Add to completed trades
    completedTrades.push(trade);

    // Update database
    if (supabase) {
      try {
        // Update paper_positions
        await supabase
          .from('paper_positions')
          .update({ status: 'closed', closed_at: new Date().toISOString() })
          .eq('symbol', position.symbol)
          .eq('status', 'open');

        // Insert into paper_trades for history
        await supabase.from('paper_trades').insert({
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
          opened_at: trade.openedAt.toISOString(),
          closed_at: trade.closedAt.toISOString(),
        });
      } catch (error) {
        // Table might not exist
      }
    }

    console.log('');
    console.log('==================================================');
    console.log(`[PAPER] *** PAPER TRADE CLOSED ***`);
    console.log(`[PAPER] ${position.side.toUpperCase()} ${position.symbol}`);
    console.log(`[PAPER] Entry: $${position.entryPrice.toFixed(6)}`);
    console.log(`[PAPER] Exit: $${exitPrice.toFixed(6)}`);
    console.log(`[PAPER] Reason: ${reason}`);
    console.log(`[PAPER] P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${leveragePnl >= 0 ? '+' : ''}${leveragePnl.toFixed(2)}%)`);
    console.log(`[PAPER] Duration: ${((Date.now() - position.openedAt.getTime()) / 60000).toFixed(1)} minutes`);
    console.log('==================================================');
    console.log('');
  }

  /**
   * Log summary of paper trading performance
   */
  private logSummary() {
    if (completedTrades.length === 0 && openPositions.size === 0) return;

    const totalTrades = completedTrades.length;
    const wins = completedTrades.filter(t => t.pnl > 0).length;
    const losses = completedTrades.filter(t => t.pnl < 0).length;
    const totalPnl = completedTrades.reduce((s, t) => s + t.pnl, 0);
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    console.log(`[PAPER] === SUMMARY ===`);
    console.log(`[PAPER] Open Positions: ${openPositions.size}`);
    console.log(`[PAPER] Completed Trades: ${totalTrades} (W:${wins} L:${losses})`);
    console.log(`[PAPER] Win Rate: ${winRate.toFixed(1)}%`);
    console.log(`[PAPER] Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  }

  /**
   * Get current paper trading stats
   */
  getStats() {
    const totalTrades = completedTrades.length;
    const wins = completedTrades.filter(t => t.pnl > 0).length;
    const totalPnl = completedTrades.reduce((s, t) => s + t.pnl, 0);

    return {
      openPositions: openPositions.size,
      completedTrades: totalTrades,
      wins,
      losses: totalTrades - wins,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      totalPnl,
    };
  }
}

// ============================================================
// Main Entry
// ============================================================

async function main() {
  const executor = new PaperTradeExecutor();

  process.on('SIGINT', async () => {
    console.log('\n[PAPER] Shutting down...');
    await executor.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[PAPER] Shutting down...');
    await executor.stop();
    process.exit(0);
  });

  await executor.start();

  // Keep running
  while (true) {
    await new Promise(r => setTimeout(r, 60000));
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export { PaperTradeExecutor };
