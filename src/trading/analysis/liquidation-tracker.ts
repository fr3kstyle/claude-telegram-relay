/**
 * Real-time Liquidation Tracker
 * Uses Bybit WebSocket for live liquidation data
 */

interface LiquidationEvent {
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  valueUsd: number;
  timestamp: number;
}

interface LiquidationSummary {
  symbol: string;
  score: number;
  reason: string;
  longLiquidations24h: number;
  shortLiquidations24h: number;
  cascadeRisk: 'long_squeeze' | 'short_squeeze' | 'neutral';
}

export class LiquidationTracker {
  private liquidations = new Map<string, LiquidationEvent[]>();
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor() {
    this.connect();
  }

  /**
   * Connect to Bybit liquidation WebSocket
   */
  private connect(): void {
    try {
      this.ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

      this.ws.onopen = () => {
        console.log('[LiquidationTracker] WebSocket connected');
        this.reconnectAttempts = 0;

        // Subscribe to all liquidation events
        this.ws?.send(JSON.stringify({
          op: 'subscribe',
          args: ['allLiquidation'],
        }));
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.topic === 'allLiquidation' && data.data) {
            this.processLiquidation(data.data);
          }
        } catch (e) {
          // Ignore parse errors
        }
      };

      this.ws.onclose = () => {
        console.log('[LiquidationTracker] WebSocket closed');
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('[LiquidationTracker] WebSocket error:', error);
      };
    } catch (error) {
      console.error('[LiquidationTracker] Connection error:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[LiquidationTracker] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    setTimeout(() => {
      console.log(`[LiquidationTracker] Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.connect();
    }, delay);
  }

  /**
   * Process incoming liquidation event
   */
  private processLiquidation(data: any): void {
    if (!data.symbol || !data.side || !data.price || !data.size) return;

    const event: LiquidationEvent = {
      symbol: data.symbol,
      side: data.side.toLowerCase(),
      price: parseFloat(data.price),
      qty: parseFloat(data.size),
      valueUsd: parseFloat(data.price) * parseFloat(data.size),
      timestamp: Date.now(),
    };

    // Store in memory
    if (!this.liquidations.has(event.symbol)) {
      this.liquidations.set(event.symbol, []);
    }
    this.liquidations.get(event.symbol)!.push(event);

    // Clean old events (keep 24h)
    this.cleanOldEvents(event.symbol);

    // Log large liquidations
    if (event.valueUsd > 10000) {
      console.log(`[LiquidationTracker] LARGE: ${event.symbol} ${event.side} $${event.valueUsd.toFixed(0)}`);
    }
  }

  /**
   * Remove events older than 24h
   */
  private cleanOldEvents(symbol: string): void {
    const events = this.liquidations.get(symbol);
    if (!events) return;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = events.filter(e => e.timestamp > cutoff);
    this.liquidations.set(symbol, filtered);
  }

  /**
   * Get liquidation summary for a symbol
   */
  getSummary(symbol: string): LiquidationSummary {
    const events = this.liquidations.get(symbol) || [];

    const longLiq = events
      .filter(e => e.side === 'sell') // Sell to close long
      .reduce((s, e) => s + e.valueUsd, 0);

    const shortLiq = events
      .filter(e => e.side === 'buy') // Buy to close short
      .reduce((s, e) => s + e.valueUsd, 0);

    // Analyze cascade risk
    let score = 50;
    let cascadeRisk: 'long_squeeze' | 'short_squeeze' | 'neutral' = 'neutral';
    let reason = 'No significant liquidations';

    if (shortLiq > longLiq * 2 && shortLiq > 50000) {
      // Heavy short liquidations = bullish (short squeeze)
      score = 75;
      cascadeRisk = 'short_squeeze';
      reason = `Short squeeze: $${(shortLiq / 1000).toFixed(0)}K short liquidations`;
    } else if (longLiq > shortLiq * 2 && longLiq > 50000) {
      // Heavy long liquidations = bearish (long cascade)
      score = 25;
      cascadeRisk = 'long_squeeze';
      reason = `Long cascade: $${(longLiq / 1000).toFixed(0)}K long liquidations`;
    } else if (shortLiq > longLiq) {
      score = 60;
      reason = `More short liquidations ($${(shortLiq / 1000).toFixed(0)}K vs $${(longLiq / 1000).toFixed(0)}K)`;
    } else if (longLiq > shortLiq) {
      score = 40;
      reason = `More long liquidations ($${(longLiq / 1000).toFixed(0)}K vs $${(shortLiq / 1000).toFixed(0)}K)`;
    }

    return {
      symbol,
      score,
      reason,
      longLiquidations24h: longLiq,
      shortLiquidations24h: shortLiq,
      cascadeRisk,
    };
  }

  /**
   * Get all symbols with recent liquidation activity
   */
  getActiveSymbols(): string[] {
    return Array.from(this.liquidations.keys())
      .filter(symbol => {
        const events = this.liquidations.get(symbol) || [];
        return events.some(e => Date.now() - e.timestamp < 3600000); // Active in last hour
      });
  }

  /**
   * Shutdown
   */
  shutdown(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Export singleton
export const liquidationTracker = new LiquidationTracker();
