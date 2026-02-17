/**
 * BEHEMOTH WebSocket Stream Manager
 *
 * Manages WebSocket connections to exchanges for real-time data:
 * - Price updates
 * - Orderbook changes
 * - Liquidation feeds
 */

import type { OHLCV, LiquidationEvent, Orderbook } from '../utils/trading-types';

// ============================================================
// Types
// ============================================================

export interface WSConfig {
  exchange: 'bybit' | 'binance';
  symbols: string[];
  onTicker?: (data: TickerUpdate) => void;
  onOrderbook?: (data: OrderbookUpdate) => void;
  onLiquidation?: (data: LiquidationEvent) => void;
  onCandle?: (data: CandleUpdate) => void;
  reconnectDelay?: number;
}

export interface TickerUpdate {
  symbol: string;
  price: number;
  bidPrice: number;
  askPrice: number;
  bidQty: number;
  askQty: number;
  timestamp: Date;
}

export interface OrderbookUpdate {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: Date;
}

export interface CandleUpdate {
  symbol: string;
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date;
  isClosed: boolean;
}

// ============================================================
// Bybit WebSocket Manager
// ============================================================

export class BybitWSManager {
  private ws: WebSocket | null = null;
  private config: WSConfig;
  private reconnectAttempts: number = 0;
  private isConnected: boolean = false;
  private pingInterval: Timer | null = null;
  private subscriptions: Set<string> = new Set();

  constructor(config: WSConfig) {
    this.config = {
      reconnectDelay: 5000,
      ...config,
    };
  }

  async connect(): Promise<void> {
    const wsUrl = 'wss://stream.bybit.com/v5/public/linear';

    console.log(`[WS:${this.config.exchange}] Connecting to ${wsUrl}`);

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[WS:${this.config.exchange}] Connected`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.subscribeAll();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(JSON.parse(event.data));
    };

    this.ws.onclose = (event) => {
      console.log(`[WS:${this.config.exchange}] Disconnected: ${event.code} ${event.reason}`);
      this.isConnected = false;
      this.stopPing();
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error(`[WS:${this.config.exchange}] Error:`, error);
    };
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  private subscribeAll(): void {
    if (!this.ws || !this.isConnected) return;

    for (const symbol of this.config.symbols) {
      // Ticker
      this.subscribe(`tickers.${symbol}`);

      // Orderbook
      this.subscribe(`orderbook.50.${symbol}`);

      // 1m candles
      this.subscribe(`kline.1.${symbol}`);
    }

    // Liquidations (all symbols)
    this.subscribe('allLiquidation');
  }

  private subscribe(topic: string): void {
    if (this.subscriptions.has(topic)) return;

    const msg = {
      op: 'subscribe',
      args: [topic],
    };

    this.ws?.send(JSON.stringify(msg));
    this.subscriptions.add(topic);
    console.log(`[WS:${this.config.exchange}] Subscribed to ${topic}`);
  }

  private handleMessage(data: any): void {
    if (data.op === 'pong') return;

    const topic = data.topic;
    if (!topic) return;

    try {
      if (topic.startsWith('tickers.')) {
        this.handleTicker(data);
      } else if (topic.startsWith('orderbook.')) {
        this.handleOrderbook(data);
      } else if (topic.startsWith('kline.')) {
        this.handleCandle(data);
      } else if (topic === 'allLiquidation') {
        this.handleLiquidation(data);
      }
    } catch (error) {
      console.error(`[WS:${this.config.exchange}] Error handling message:`, error);
    }
  }

  private handleTicker(data: any): void {
    const symbol = data.topic.replace('tickers.', '');
    const tick = data.data;

    const update: TickerUpdate = {
      symbol,
      price: parseFloat(tick.lastPrice),
      bidPrice: parseFloat(tick.bid1Price),
      askPrice: parseFloat(tick.ask1Price),
      bidQty: parseFloat(tick.bid1Size),
      askQty: parseFloat(tick.ask1Size),
      timestamp: new Date(data.ts),
    };

    this.config.onTicker?.(update);
  }

  private handleOrderbook(data: any): void {
    const symbol = data.topic.match(/orderbook\.50\.(.+)/)?.[1];
    if (!symbol) return;

    const book = data.data;

    const update: OrderbookUpdate = {
      symbol,
      bids: (book.b || []).map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: (book.a || []).map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: new Date(data.ts),
    };

    this.config.onOrderbook?.(update);
  }

  private handleCandle(data: any): void {
    const match = data.topic.match(/kline\.(\d+)\.(.+)/);
    if (!match) return;

    const interval = match[1];
    const symbol = match[2];
    const candle = data.data;

    const update: CandleUpdate = {
      symbol,
      interval: `${interval}m`,
      open: parseFloat(candle.open),
      high: parseFloat(candle.high),
      low: parseFloat(candle.low),
      close: parseFloat(candle.close),
      volume: parseFloat(candle.volume),
      timestamp: new Date(candle.start),
      isClosed: candle.confirm,
    };

    this.config.onCandle?.(update);
  }

  private handleLiquidation(data: any): void {
    const liq = data.data;

    const event: LiquidationEvent = {
      exchange: 'bybit',
      symbol: liq.symbol,
      side: liq.side.toLowerCase() === 'buy' ? 'buy' : 'sell',
      price: parseFloat(liq.price),
      quantity: parseFloat(liq.size),
      usdValue: parseFloat(liq.price) * parseFloat(liq.size),
      orderType: liq.type || 'market',
      timestamp: new Date(data.ts),
    };

    this.config.onLiquidation?.(event);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.config.reconnectDelay! * Math.pow(2, this.reconnectAttempts),
      60000
    );

    console.log(`[WS:${this.config.exchange}] Reconnecting in ${delay}ms...`);

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  getStatus(): { connected: boolean; subscriptions: number; reconnectAttempts: number } {
    return {
      connected: this.isConnected,
      subscriptions: this.subscriptions.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// ============================================================
// Binance WebSocket Manager
// ============================================================

export class BinanceWSManager {
  private ws: WebSocket | null = null;
  private config: WSConfig;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;

  constructor(config: WSConfig) {
    this.config = {
      reconnectDelay: 5000,
      ...config,
    };
  }

  async connect(): Promise<void> {
    // Build stream names
    const streams = this.config.symbols.flatMap((s) => [
      `${s.toLowerCase()}@ticker`,
      `${s.toLowerCase()}@depth20@100ms`,
      `${s.toLowerCase()}@kline_1m`,
    ]);

    // Add all liquidations stream
    streams.push('!forceOrder@arr');

    const wsUrl = `wss://fstream.binance.com/stream?streams=${streams.join('/')}`;

    console.log(`[WS:binance] Connecting to Binance Futures`);

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[WS:binance] Connected`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(JSON.parse(event.data));
    };

    this.ws.onclose = () => {
      console.log(`[WS:binance] Disconnected`);
      this.isConnected = false;
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error(`[WS:binance] Error:`, error);
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  private handleMessage(data: any): void {
    const stream = data.stream;
    if (!stream) return;

    const payload = data.data;

    try {
      if (stream.includes('@ticker')) {
        this.handleTicker(payload);
      } else if (stream.includes('@depth')) {
        this.handleOrderbook(payload);
      } else if (stream.includes('@kline')) {
        this.handleCandle(payload);
      } else if (stream === '!forceOrder@arr') {
        this.handleLiquidation(payload);
      }
    } catch (error) {
      console.error(`[WS:binance] Error handling message:`, error);
    }
  }

  private handleTicker(data: any): void {
    const update: TickerUpdate = {
      symbol: data.s,
      price: parseFloat(data.c),
      bidPrice: parseFloat(data.b),
      askPrice: parseFloat(data.a),
      bidQty: parseFloat(data.B),
      askQty: parseFloat(data.A),
      timestamp: new Date(data.E),
    };

    this.config.onTicker?.(update);
  }

  private handleOrderbook(data: any): void {
    const update: OrderbookUpdate = {
      symbol: data.s,
      bids: data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: new Date(),
    };

    this.config.onOrderbook?.(update);
  }

  private handleCandle(data: any): void {
    const k = data.k;

    const update: CandleUpdate = {
      symbol: k.s,
      interval: k.i,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      timestamp: new Date(k.t),
      isClosed: k.x,
    };

    this.config.onCandle?.(update);
  }

  private handleLiquidation(data: any): void {
    const order = data.o;

    const event: LiquidationEvent = {
      exchange: 'binance',
      symbol: order.s,
      side: order.S.toLowerCase() === 'buy' ? 'buy' : 'sell',
      price: parseFloat(order.p),
      quantity: parseFloat(order.q),
      usdValue: parseFloat(order.p) * parseFloat(order.q),
      orderType: order.o.toLowerCase(),
      timestamp: new Date(order.T),
    };

    this.config.onLiquidation?.(event);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.config.reconnectDelay! * Math.pow(2, this.reconnectAttempts),
      60000
    );

    console.log(`[WS:binance] Reconnecting in ${delay}ms...`);

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  getStatus(): { connected: boolean; reconnectAttempts: number } {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// ============================================================
// Combined Stream Manager
// ============================================================

export class StreamManager {
  private bybit: BybitWSManager | null = null;
  private binance: BinanceWSManager | null = null;

  async connect(config: WSConfig): Promise<void> {
    if (config.exchange === 'bybit' || !config.exchange) {
      this.bybit = new BybitWSManager(config);
      await this.bybit.connect();
    }

    if (config.exchange === 'binance' || !config.exchange) {
      this.binance = new BinanceWSManager(config);
      await this.binance.connect();
    }
  }

  disconnect(): void {
    this.bybit?.disconnect();
    this.binance?.disconnect();
  }

  getStatus(): {
    bybit: { connected: boolean; subscriptions: number } | null;
    binance: { connected: boolean } | null;
  } {
    return {
      bybit: this.bybit?.getStatus() || null,
      binance: this.binance?.getStatus() || null,
    };
  }
}
