/**
 * BEHEMOTH Trade Executor
 *
 * Executes trades via Bybit API with:
 * - Smart order routing
 * - Position management
 * - Order tracking
 */

import { createClient } from "@supabase/supabase-js";
import type {
  TradeExecution,
  TradingSignal,
  Side,
  PositionSide,
  OrderType,
  ExchangePosition,
  ExchangeOrder,
} from '../utils/trading-types';

// ============================================================
// Configuration
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";
const BYBIT_API_KEY = process.env.BYBIT_API_KEY || "";
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || "";
const BYBIT_TESTNET = process.env.BYBIT_TESTNET === "true";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const BASE_URL = BYBIT_TESTNET
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

// Track auth failures to enable graceful degradation
let authFailureCount = 0;
const AUTH_FAILURE_THRESHOLD = 3;

// ============================================================
// Trade Executor Class
// ============================================================

export class TradeExecutor {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = BYBIT_API_KEY;
    this.apiSecret = BYBIT_API_SECRET;
    this.baseUrl = BASE_URL;
  }

  /**
   * Execute a signal as a trade
   */
  async executeSignal(
    signal: TradingSignal,
    leverage: number,
    positionSizeUsd: number
  ): Promise<TradeExecution | null> {
    console.log(
      `[Executor] Executing ${signal.signalType} on ${signal.symbol} @ ${signal.entryPrice}`
    );

    try {
      // Set leverage first
      await this.setLeverage(signal.symbol, leverage);

      // Place market order
      const order = await this.placeOrder({
        symbol: signal.symbol,
        side: signal.signalType === 'long' ? 'buy' : 'sell',
        orderType: 'market',
        qty: positionSizeUsd / signal.entryPrice,
        positionSide: signal.signalType === 'long' ? 'long' : 'short',
      });

      if (!order) {
        console.error('[Executor] Order failed');
        return null;
      }

      // Create execution record
      const execution: TradeExecution = {
        id: undefined,
        signalId: signal.id,
        symbol: signal.symbol,
        side: signal.signalType === 'long' ? 'buy' : 'sell',
        positionSide: signal.signalType,
        orderType: 'market',
        positionSizeUsd,
        positionSizeCoin: positionSizeUsd / signal.entryPrice,
        leverage,
        marginUsed: positionSizeUsd / leverage,
        notionalValue: positionSizeUsd,
        entryPrice: order.avgPrice || signal.entryPrice,
        stopLossPrice: signal.stopLoss,
        takeProfitPrice: signal.takeProfit1,
        exchange: 'bybit',
        exchangeOrderId: order.orderId,
        realizedPnl: 0,
        realizedPnlPercent: 0,
        unrealizedPnl: 0,
        fundingFees: 0,
        tradingFees: 0,
        status: 'open',
        openedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Save to database
      const savedExecution = await this.saveExecution(execution);

      // Set stop loss and take profit
      if (signal.stopLoss) {
        await this.setStopLoss(
          signal.symbol,
          signal.signalType,
          signal.stopLoss,
          execution.positionSizeCoin
        );
      }

      // Create alert
      await this.createTradeAlert(savedExecution || execution, 'opened');

      return savedExecution || execution;
    } catch (error) {
      console.error('[Executor] Error executing signal:', error);
      return null;
    }
  }

  /**
   * Place order on Bybit
   */
  async placeOrder(params: {
    symbol: string;
    side: Side;
    orderType: OrderType;
    qty: number;
    price?: number;
    positionSide?: PositionSide;
    stopLoss?: number;
    takeProfit?: number;
  }): Promise<ExchangeOrder | null> {
    const endpoint = '/v5/order/create';

    const body: Record<string, any> = {
      category: 'linear',
      symbol: params.symbol,
      side: params.side.toUpperCase(),
      orderType: params.orderType.toUpperCase(),
      qty: params.qty.toFixed(6),
      positionIdx: params.positionSide === 'short' ? 2 : 0,
    };

    if (params.price) {
      body.price = params.price.toFixed(2);
    }

    if (params.stopLoss) {
      body.stopLoss = params.stopLoss.toFixed(2);
    }

    if (params.takeProfit) {
      body.takeProfit = params.takeProfit.toFixed(2);
    }

    try {
      const response = await this.signedRequest('POST', endpoint, body);

      if (!response) {
        console.error('[Executor] Order error: no response (network error)');
        return null;
      }

      if (response.retCode !== 0) {
        console.error('[Executor] Order error:', response.retMsg);
        return null;
      }

      return {
        id: response.result.orderId,
        symbol: params.symbol,
        side: params.side,
        type: params.orderType,
        price: params.price,
        quantity: params.qty,
        filledQuantity: 0,
        status: 'new',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } catch (error) {
      console.error('[Executor] Exception placing order:', error);
      return null;
    }
  }

  /**
   * Set leverage for symbol
   */
  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    const endpoint = '/v5/position/set-leverage';

    const body = {
      category: 'linear',
      symbol,
      buyLeverage: leverage.toString(),
      sellLeverage: leverage.toString(),
    };

    try {
      const response = await this.signedRequest('POST', endpoint, body);

      if (!response) {
        console.error('[Executor] Set leverage error: no response (network error)');
        return false;
      }

      if (response.retCode !== 0 && !response.retMsg.includes('same')) {
        console.error('[Executor] Set leverage error:', response.retMsg);
        return false;
      }

      console.log(`[Executor] Leverage set to ${leverage}x for ${symbol}`);
      return true;
    } catch (error) {
      console.error('[Executor] Exception setting leverage:', error);
      return false;
    }
  }

  /**
   * Set trailing stop on open position
   * @param symbol - Trading pair
   * @param trailPercent - Trailing distance in percent (min 0.5, recommended 1.0+)
   * @param activationPrice - Price at which trailing becomes active (optional)
   */
  async setTrailingStop(
    symbol: string,
    trailPercent: number = 1.0,
    activationPrice?: number
  ): Promise<boolean> {
    const endpoint = '/v5/position/trading-stop';

    // Ensure minimum trail percent
    const trail = Math.max(0.5, trailPercent);

    const body: Record<string, any> = {
      category: 'linear',
      symbol,
      positionIdx: 0, // One-way mode
      trailingStop: trail.toFixed(1),
      tpslMode: 'Full',
    };

    if (activationPrice) {
      body.activePrice = activationPrice.toFixed(5);
    }

    try {
      const response = await this.signedRequest('POST', endpoint, body);

      if (!response) {
        console.error('[Executor] Trailing stop error: no response (network error)');
        return false;
      }

      if (response.retCode !== 0) {
        console.error('[Executor] Trailing stop error:', response.retMsg);
        return false;
      }

      console.log(`[Executor] Trailing stop set: ${trail}% trail${activationPrice ? ', activation at ' + activationPrice : ''}`);
      return true;
    } catch (error) {
      console.error('[Executor] Exception setting trailing stop:', error);
      return false;
    }
  }

  /**
   * Set stop loss order
   */
  async setStopLoss(
    symbol: string,
    positionSide: 'long' | 'short',
    stopPrice: number,
    qty: number
  ): Promise<boolean> {
    const endpoint = '/v5/order/create';

    const body: Record<string, any> = {
      category: 'linear',
      symbol,
      side: positionSide === 'long' ? 'sell' : 'buy',
      orderType: 'StopMarket',
      qty: qty.toFixed(6),
      stopPrice: stopPrice.toFixed(2),
      positionIdx: positionSide === 'short' ? 2 : 0,
    };

    try {
      const response = await this.signedRequest('POST', endpoint, body);

      if (!response) {
        console.error('[Executor] Stop loss error: no response (network error)');
        return false;
      }

      if (response.retCode !== 0) {
        console.error('[Executor] Stop loss error:', response.retMsg);
        return false;
      }

      console.log(`[Executor] Stop loss set at ${stopPrice} for ${symbol}`);
      return true;
    } catch (error) {
      console.error('[Executor] Exception setting stop loss:', error);
      return false;
    }
  }

  /**
   * Close a position
   */
  async closePosition(
    symbol: string,
    positionSide: 'long' | 'short',
    qty: number,
    reason: string = 'manual'
  ): Promise<boolean> {
    const endpoint = '/v5/order/create';

    const body = {
      category: 'linear',
      symbol,
      side: positionSide === 'long' ? 'sell' : 'buy',
      orderType: 'Market',
      qty: Math.abs(qty).toFixed(6),
      reduceOnly: true,
      positionIdx: positionSide === 'short' ? 2 : 0,
    };

    try {
      const response = await this.signedRequest('POST', endpoint, body);

      if (!response) {
        console.error('[Executor] Close position error: no response (network error)');
        return false;
      }

      if (response.retCode !== 0) {
        console.error('[Executor] Close position error:', response.retMsg);
        return false;
      }

      console.log(`[Executor] Position closed: ${symbol} ${positionSide} (${reason})`);
      return true;
    } catch (error) {
      console.error('[Executor] Exception closing position:', error);
      return false;
    }
  }

  /**
   * Get current positions
   */
  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    const endpoint = '/v5/position/list';
    const params: Record<string, string> = { category: 'linear' };

    if (symbol) {
      params.symbol = symbol;
    }

    try {
      const response = await this.signedRequest('GET', endpoint, params, true);

      if (!response) {
        console.error('[Executor] Get positions: no response (network error)');
        return [];
      }

      if (response.retCode !== 0) {
        console.error('[Executor] Get positions error:', response.retMsg);
        return [];
      }

      return (response.result?.list || []).map((p: any) => ({
        symbol: p.symbol,
        side: p.side.toLowerCase() as PositionSide,
        size: parseFloat(p.size),
        entryPrice: parseFloat(p.avgPrice),
        unrealizedPnl: parseFloat(p.unrealisedPnl),
        leverage: parseInt(p.leverage),
        liquidationPrice: parseFloat(p.liqPrice) || undefined,
        stopLoss: parseFloat(p.stopLoss) || undefined,
        takeProfit: parseFloat(p.takeProfit) || undefined,
      }));
    } catch (error) {
      console.error('[Executor] Exception getting positions:', error);
      return [];
    }
  }

  /**
   * Get account balance
   */
  async getBalance(): Promise<{ currency: string; total: number; free: number }[]> {
    const endpoint = '/v5/account/wallet-balance';
    const params = { accountType: 'UNIFIED' };

    try {
      const response = await this.signedRequest('GET', endpoint, params, true);

      if (!response) {
        console.error('[Executor] Get balance: no response (network error)');
        return [];
      }

      if (response.retCode !== 0) {
        console.error('[Executor] Get balance error:', response.retMsg);
        return [];
      }

      const coins = response.result?.list?.[0]?.coin || [];

      return coins.map((c: any) => ({
        currency: c.coin,
        total: parseFloat(c.walletBalance),
        free: parseFloat(c.availableToWithdraw),
      }));
    } catch (error) {
      console.error('[Executor] Exception getting balance:', error);
      return [];
    }
  }

  /**
   * Emergency close all positions
   */
  async emergencyCloseAll(): Promise<number> {
    console.log('[Executor] EMERGENCY CLOSE ALL POSITIONS');

    const positions = await this.getPositions();
    let closedCount = 0;

    for (const position of positions) {
      if (position.size > 0) {
        const success = await this.closePosition(
          position.symbol,
          position.side,
          position.size,
          'emergency'
        );
        if (success) closedCount++;
      }
    }

    // Cancel all open orders
    await this.cancelAllOrders();

    return closedCount;
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(symbol?: string): Promise<void> {
    const endpoint = '/v5/order/cancel-all';

    const body: Record<string, any> = {
      category: 'linear',
    };

    if (symbol) {
      body.symbol = symbol;
    }

    try {
      await this.signedRequest('POST', endpoint, body);
      console.log('[Executor] All orders cancelled');
    } catch (error) {
      console.error('[Executor] Exception cancelling orders:', error);
    }
  }

  /**
   * Save execution to database
   */
  private async saveExecution(execution: TradeExecution): Promise<TradeExecution | null> {
    if (!supabase) return null;

    try {
      const { data, error } = await supabase
        .from('trade_executions')
        .insert({
          signal_id: execution.signalId,
          symbol: execution.symbol,
          side: execution.side,
          position_side: execution.positionSide,
          order_type: execution.orderType,
          position_size_usd: execution.positionSizeUsd,
          position_size_coin: execution.positionSizeCoin,
          leverage: execution.leverage,
          margin_used: execution.marginUsed,
          notional_value: execution.notionalValue,
          entry_price: execution.entryPrice,
          stop_loss_price: execution.stopLossPrice,
          take_profit_price: execution.takeProfitPrice,
          exchange: execution.exchange,
          exchange_order_id: execution.exchangeOrderId,
          status: execution.status,
          opened_at: execution.openedAt?.toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        console.error('[Executor] Error saving execution:', error);
        return null;
      }

      execution.id = data.id;
      return execution;
    } catch (error) {
      console.error('[Executor] Exception saving execution:', error);
      return null;
    }
  }

  /**
   * Create trade alert
   */
  private async createTradeAlert(
    execution: TradeExecution,
    type: 'opened' | 'closed'
  ): Promise<void> {
    if (!supabase) return;

    const alertType = type === 'opened' ? 'trade_opened' : 'trade_closed';
    const title = type === 'opened'
      ? `Opened ${execution.positionSide.toUpperCase()} on ${execution.symbol}`
      : `Closed ${execution.symbol}`;

    const message = type === 'opened'
      ? `${execution.symbol} ${execution.positionSide} @ ${execution.entryPrice.toFixed(2)} | ${execution.leverage}x leverage`
      : `${execution.symbol} closed | PnL: ${execution.realizedPnlPercent.toFixed(2)}%`;

    await supabase.from('alerts').insert({
      alert_type: alertType,
      severity: 'info',
      title,
      message,
      symbol: execution.symbol,
      execution_id: execution.id,
      voice_alert: true,
      voice_message: type === 'opened'
        ? `Opened ${execution.positionSide} on ${execution.symbol.replace('USDT', '')} at ${execution.entryPrice.toFixed(2)}`
        : execution.realizedPnl > 0
          ? `Nice! Closed ${execution.symbol.replace('USDT', '')} for ${execution.realizedPnlPercent.toFixed(1)} percent profit`
          : `Closed ${execution.symbol.replace('USDT', '')} with ${execution.realizedPnlPercent.toFixed(1)} percent loss`,
    });
  }

  /**
   * Signed API request to Bybit
   */
  private async signedRequest(
    method: 'GET' | 'POST',
    endpoint: string,
    body: Record<string, any> | null,
    isQuery: boolean = false
  ): Promise<any> {
    const timestamp = Date.now();
    const recvWindow = 5000;

    let queryString = '';
    let requestBody = '';

    if (isQuery || method === 'GET') {
      if (body) {
        // Sort params alphabetically for correct signature
        const sortedParams = Object.entries(body)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join('&');
        queryString = endpoint.includes('?') ? `&${sortedParams}` : `?${sortedParams}`;
      }
    } else {
      requestBody = JSON.stringify(body);
    }

    // Sign string format: timestamp + apiKey + recvWindow + queryString (without ?)
    const signString = timestamp + this.apiKey + recvWindow + (requestBody || queryString.replace('?', ''));

    // Generate signature using Web Crypto API
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.apiSecret);
    const msgData = encoder.encode(signString);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const signHex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const headers: Record<string, string> = {
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-TIMESTAMP': timestamp.toString(),
      'X-BAPI-RECV-WINDOW': recvWindow.toString(),
      'X-BAPI-SIGN': signHex,
      'Content-Type': 'application/json',
    };

    const url = this.baseUrl + endpoint + queryString;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? requestBody : undefined,
      });

      if (!response.ok) {
        console.error(`[Executor] API error: ${response.status} ${response.statusText}`);
        // Track auth failures
        if (response.status === 401 || response.status === 403) {
          authFailureCount++;
          console.error(`[Executor] Auth failure #${authFailureCount}`);
        }
        return null;
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[Executor] Request failed:', error);
      return null;
    }
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Trade Executor');
  console.log('='.repeat(50));

  // Guard: Check credentials before attempting API calls
  // Check both truthiness AND minimum length (API keys are at least 10 chars)
  const hasValidKey = BYBIT_API_KEY && BYBIT_API_KEY.length >= 10;
  const hasValidSecret = BYBIT_API_SECRET && BYBIT_API_SECRET.length >= 10;

  if (!hasValidKey || !hasValidSecret) {
    console.log('[Executor] Bybit credentials not configured or invalid - idling');
    console.log('[Executor] Set BYBIT_API_KEY and BYBIT_API_SECRET to enable trading');
    console.log(`[Executor] Key length: ${BYBIT_API_KEY?.length || 0}, Secret length: ${BYBIT_API_SECRET?.length || 0}`);
    // Stay alive but idle - PM2 manages lifecycle
    setInterval(() => {
      // Heartbeat every 5 minutes to show we're alive
      console.log('[Executor] Idle - waiting for Bybit credentials');
    }, 300000);
    return;
  }

  const executor = new TradeExecutor();

  // Check balance - if this fails with auth error, idle instead of crashing
  const balance = await executor.getBalance();
  console.log('[Executor] Balance:', balance);

  // Get positions
  const positions = await executor.getPositions();
  console.log('[Executor] Positions:', positions);

  // Check if we hit auth failures - if so, idle to avoid restart loop
  if (authFailureCount > 0) {
    console.log('[Executor] Auth failures detected - credentials may be invalid');
    console.log('[Executor] Idling to avoid restart loop...');
    setInterval(() => {
      console.log('[Executor] Idle - waiting for valid Bybit credentials');
    }, 300000);
    return;
  }

  // If we got here with no auth failures but no balance, still idle to stay alive
  // This handles the case where API returns empty but no error
  setInterval(() => {
    // Heartbeat every 5 minutes to show we're alive
    console.log('[Executor] Running - monitoring for signals');
  }, 300000);
}

if (import.meta.main) {
  main().catch(console.error);
}

export { BASE_URL };
