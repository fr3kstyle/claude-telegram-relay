/**
 * BEHEMOTH Position Manager
 *
 * Manages open positions:
 * - Trailing stops
 * - Take profit management
 * - MFE/MAE tracking
 * - Position updates
 */

import { createClient } from "@supabase/supabase-js";
import type { TradeExecution, PositionSide } from '../utils/trading-types';
import { TradeExecutor } from './trade-executor';

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// Trailing stop configuration
const TRAILING_STOP_CONFIG = {
  activationPercent: 1.0, // Activate after 1% profit
  trailPercent: 0.5, // Trail by 0.5%
  minProfitLock: 0.3, // Lock in at least 0.3% profit
};

// ============================================================
// Position Manager Class
// ============================================================

export class PositionManager {
  private executor: TradeExecutor;
  private checkInterval: Timer | null = null;
  private isRunning: boolean = false;
  private positionStates: Map<string, PositionState> = new Map();

  constructor(executor: TradeExecutor) {
    this.executor = executor;
  }

  /**
   * Start position monitoring
   */
  async start(intervalMs: number = 5000): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log('[PositionManager] Starting position monitor');

    // Load existing positions
    await this.loadOpenPositions();

    // Start monitoring loop
    this.checkInterval = setInterval(() => this.runPositionCheck(), intervalMs);
  }

  /**
   * Stop position monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    console.log('[PositionManager] Stopped');
  }

  /**
   * Load open positions from database
   */
  private async loadOpenPositions(): Promise<void> {
    if (!supabase) return;

    const { data } = await supabase
      .from('trade_executions')
      .select('*')
      .eq('status', 'open');

    if (data) {
      for (const exec of data) {
        this.positionStates.set(exec.id, {
          executionId: exec.id,
          symbol: exec.symbol,
          positionSide: exec.position_side,
          entryPrice: exec.entry_price,
          stopLoss: exec.stop_loss_price,
          currentPrice: exec.entry_price,
          highestPrice: exec.entry_price,
          lowestPrice: exec.entry_price,
          mfe: 0,
          mae: 0,
          trailingActive: false,
          trailingStopPrice: null,
        });
      }
    }
  }

  /**
   * Run position check cycle
   */
  private async runPositionCheck(): Promise<void> {
    try {
      const positions = await this.executor.getPositions();

      for (const position of positions) {
        if (position.size <= 0) continue;

        // Get current price from ticker
        const ticker = await this.getTicker(position.symbol);
        if (!ticker) continue;

        const state = this.positionStates.get(position.symbol + position.side);
        if (!state) {
          // New position, initialize state
          await this.initializePositionState(position, ticker.lastPrice);
          continue;
        }

        // Update position state
        await this.updatePositionState(state, ticker.lastPrice, position);

        // Check trailing stop
        await this.checkTrailingStop(state, position);

        // Check take profit levels
        await this.checkTakeProfits(state, position);
      }

      // Clean up closed positions
      await this.cleanupClosedPositions(positions);
    } catch (error) {
      console.error('[PositionManager] Position check error:', error);
    }
  }

  /**
   * Initialize position state
   */
  private async initializePositionState(
    position: any,
    currentPrice: number
  ): Promise<PositionState> {
    const state: PositionState = {
      executionId: position.symbol + position.side,
      symbol: position.symbol,
      positionSide: position.side,
      entryPrice: position.entryPrice,
      stopLoss: position.stopLoss,
      currentPrice,
      highestPrice: currentPrice,
      lowestPrice: currentPrice,
      mfe: 0,
      mae: 0,
      trailingActive: false,
      trailingStopPrice: null,
    };

    this.positionStates.set(state.executionId, state);
    return state;
  }

  /**
   * Update position state with current price
   */
  private async updatePositionState(
    state: PositionState,
    currentPrice: number,
    position: any
  ): Promise<void> {
    state.currentPrice = currentPrice;

    // Update high/low
    if (currentPrice > state.highestPrice) {
      state.highestPrice = currentPrice;
    }
    if (currentPrice < state.lowestPrice) {
      state.lowestPrice = currentPrice;
    }

    // Calculate MFE/MAE
    if (state.positionSide === 'long') {
      state.mfe = ((state.highestPrice - state.entryPrice) / state.entryPrice) * 100;
      state.mae = ((state.lowestPrice - state.entryPrice) / state.entryPrice) * 100;
    } else {
      state.mfe = ((state.entryPrice - state.lowestPrice) / state.entryPrice) * 100;
      state.mae = ((state.entryPrice - state.highestPrice) / state.entryPrice) * 100;
    }

    // Update database
    if (supabase) {
      await supabase.rpc('update_execution_pnl', {
        p_execution_id: state.executionId,
        p_current_price: currentPrice,
      });
    }
  }

  /**
   * Check and update trailing stop
   */
  private async checkTrailingStop(state: PositionState, position: any): Promise<void> {
    // Calculate current profit percent
    let profitPercent: number;
    if (state.positionSide === 'long') {
      profitPercent = ((state.currentPrice - state.entryPrice) / state.entryPrice) * 100;
    } else {
      profitPercent = ((state.entryPrice - state.currentPrice) / state.entryPrice) * 100;
    }

    // Check if trailing should activate
    if (!state.trailingActive && profitPercent >= TRAILING_STOP_CONFIG.activationPercent) {
      state.trailingActive = true;
      console.log(`[PositionManager] Trailing stop activated for ${state.symbol}`);
    }

    if (!state.trailingActive) return;

    // Calculate new trailing stop
    let newTrailingStop: number;
    if (state.positionSide === 'long') {
      newTrailingStop = state.highestPrice * (1 - TRAILING_STOP_CONFIG.trailPercent / 100);

      // Only move stop up, never down
      if (!state.trailingStopPrice || newTrailingStop > state.trailingStopPrice) {
        state.trailingStopPrice = newTrailingStop;

        // Update stop loss on exchange
        await this.executor.setStopLoss(
          state.symbol,
          state.positionSide,
          newTrailingStop,
          position.size
        );

        console.log(`[PositionManager] Updated trailing stop: ${newTrailingStop.toFixed(2)}`);
      }
    } else {
      newTrailingStop = state.lowestPrice * (1 + TRAILING_STOP_CONFIG.trailPercent / 100);

      if (!state.trailingStopPrice || newTrailingStop < state.trailingStopPrice) {
        state.trailingStopPrice = newTrailingStop;

        await this.executor.setStopLoss(
          state.symbol,
          state.positionSide,
          newTrailingStop,
          position.size
        );

        console.log(`[PositionManager] Updated trailing stop: ${newTrailingStop.toFixed(2)}`);
      }
    }
  }

  /**
   * Check take profit levels
   */
  private async checkTakeProfits(state: PositionState, position: any): Promise<void> {
    // Get take profit levels from execution
    if (!supabase) return;

    const { data: execution } = await supabase
      .from('trade_executions')
      .select('take_profit_price, metadata')
      .eq('id', state.executionId)
      .single();

    if (!execution?.take_profit_price) return;

    const tp1 = execution.take_profit_price;
    let hitTP = false;

    if (state.positionSide === 'long' && state.currentPrice >= tp1) {
      hitTP = true;
    } else if (state.positionSide === 'short' && state.currentPrice <= tp1) {
      hitTP = true;
    }

    if (hitTP) {
      // Close partial or full position at TP1
      console.log(`[PositionManager] Take profit hit for ${state.symbol}`);

      // Could implement partial close here
      // For now, let trailing stop manage the exit
    }
  }

  /**
   * Clean up closed positions from state
   */
  private async cleanupClosedPositions(openPositions: any[]): Promise<void> {
    const openKeys = new Set(
      openPositions.map(p => p.symbol + p.side)
    );

    for (const [key, state] of this.positionStates) {
      if (!openKeys.has(key)) {
        // Position closed, update final metrics
        if (supabase) {
          await supabase
            .from('trade_executions')
            .update({
              mfe: state.mfe,
              mae: state.mae,
              mfe_price: state.highestPrice,
              mae_price: state.lowestPrice,
            })
            .eq('id', state.executionId);
        }

        this.positionStates.delete(key);
        console.log(`[PositionManager] Cleaned up closed position: ${state.symbol}`);
      }
    }
  }

  /**
   * Get ticker data
   */
  private async getTicker(symbol: string): Promise<{ lastPrice: number } | null> {
    try {
      const response = await fetch(
        `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
      );

      const data = await response.json();
      const ticker = data.result?.list?.[0];

      if (ticker) {
        return { lastPrice: parseFloat(ticker.lastPrice) };
      }
    } catch (error) {
      console.error(`[PositionManager] Error getting ticker for ${symbol}:`, error);
    }

    return null;
  }

  /**
   * Get position state
   */
  getPositionState(symbol: string, side: PositionSide): PositionState | undefined {
    return this.positionStates.get(symbol + side);
  }

  /**
   * Get all position states
   */
  getAllPositionStates(): PositionState[] {
    return Array.from(this.positionStates.values());
  }
}

// ============================================================
// Types
// ============================================================

interface PositionState {
  executionId: string;
  symbol: string;
  positionSide: PositionSide;
  entryPrice: number;
  stopLoss?: number;
  currentPrice: number;
  highestPrice: number;
  lowestPrice: number;
  mfe: number; // Maximum Favorable Excursion
  mae: number; // Maximum Adverse Excursion
  trailingActive: boolean;
  trailingStopPrice: number | null;
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Position Manager');
  console.log('='.repeat(50));

  const executor = new TradeExecutor();
  const positionManager = new PositionManager(executor);

  await positionManager.start(5000);

  process.on('SIGINT', () => {
    positionManager.stop();
    process.exit(0);
  });
}

if (import.meta.main) {
  main().catch(console.error);
}
