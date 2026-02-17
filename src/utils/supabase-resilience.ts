/**
 * Supabase Resilience Layer
 *
 * Provides graceful degradation when Supabase is unavailable:
 * - Health monitoring with circuit breaker integration
 * - In-memory read cache for surviving brief outages
 * - Consistent fallback behavior across all Supabase operations
 *
 * Usage:
 *   const resilience = new SupabaseResilience(supabaseClient);
 *   const result = await resilience.read('memory', () => supabase.from('memory').select());
 */

import { CircuitBreaker, circuitBreakers } from './circuit-breaker.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface ResilienceConfig {
  /** Cache TTL in milliseconds (default: 60000 = 1 minute) */
  cacheTtl: number;
  /** Max cache entries per category (default: 100) */
  maxCacheSize: number;
  /** Enable verbose logging */
  debug: boolean;
}

export interface HealthStatus {
  isConfigured: boolean;
  isHealthy: boolean;
  lastCheck: Date | null;
  consecutiveFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
}

const DEFAULT_CONFIG: ResilienceConfig = {
  cacheTtl: 60000, // 1 minute
  maxCacheSize: 100,
  debug: false,
};

/**
 * Resilience wrapper for Supabase operations.
 * Provides caching and circuit breaker protection.
 */
export class SupabaseResilience {
  private cache = new Map<string, Map<string, CacheEntry<unknown>>>();
  private healthStatus: HealthStatus;
  private circuitBreaker: CircuitBreaker;
  private lastHealthCheck: Date | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly supabase: SupabaseClient | null,
    private readonly config: ResilienceConfig = DEFAULT_CONFIG
  ) {
    this.healthStatus = {
      isConfigured: !!supabase,
      isHealthy: !!supabase,
      lastCheck: null,
      consecutiveFailures: 0,
      circuitState: 'closed',
    };

    this.circuitBreaker = circuitBreakers.get('supabase', {
      failureThreshold: 3,
      resetTimeout: 30000, // 30 seconds
      successThreshold: 1,
      onOpen: () => {
        this.healthStatus.circuitState = 'open';
        console.warn('[SupabaseResilience] Circuit OPEN - Supabase appears unavailable');
      },
      onClose: () => {
        this.healthStatus.circuitState = 'closed';
        this.consecutiveFailures = 0;
        console.log('[SupabaseResilience] Circuit CLOSED - Supabase recovered');
      },
    });
  }

  /**
   * Check if Supabase is configured and healthy enough for operations.
   */
  isAvailable(): boolean {
    if (!this.supabase) return false;
    return !this.circuitBreaker.isOpen();
  }

  /**
   * Get current health status.
   */
  getHealth(): HealthStatus {
    return { ...this.healthStatus };
  }

  /**
   * Perform a health check by making a lightweight query.
   * Returns true if healthy, false otherwise.
   */
  async checkHealth(): Promise<boolean> {
    if (!this.supabase) {
      this.healthStatus.isHealthy = false;
      return false;
    }

    try {
      // Lightweight query - just check connection
      const { error } = await this.supabase
        .from('threads')
        .select('id')
        .limit(1);

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows, which is fine
        throw error;
      }

      this.healthStatus.isHealthy = true;
      this.healthStatus.lastCheck = new Date();
      this.consecutiveFailures = 0;
      this.circuitBreaker.recordSuccess();
      return true;
    } catch (error) {
      this.healthStatus.isHealthy = false;
      this.healthStatus.lastCheck = new Date();
      this.consecutiveFailures++;
      this.circuitBreaker.recordFailure(error);

      if (this.config.debug) {
        console.error('[SupabaseResilience] Health check failed:', error);
      }
      return false;
    }
  }

  /**
   * Execute a read operation with caching and fallback.
   * Returns cached data if Supabase is unavailable.
   */
  async read<T>(
    category: string,
    key: string,
    fetcher: () => Promise<T>,
    fallback: T
  ): Promise<T> {
    // Check cache first
    const cached = this.getFromCache<T>(category, key);
    if (cached !== null) {
      if (this.config.debug) {
        console.log(`[SupabaseResilience] Cache HIT: ${category}/${key}`);
      }
      return cached;
    }

    // If not configured, return fallback immediately
    if (!this.supabase) {
      if (this.config.debug) {
        console.log(`[SupabaseResilience] Not configured, using fallback: ${category}/${key}`);
      }
      return fallback;
    }

    // If circuit is open, return fallback
    if (this.circuitBreaker.isOpen()) {
      if (this.config.debug) {
        console.log(`[SupabaseResilience] Circuit open, using fallback: ${category}/${key}`);
      }
      return fallback;
    }

    try {
      const result = await this.circuitBreaker.execute(fetcher);
      this.setCache(category, key, result);
      return result;
    } catch (error) {
      console.error(`[SupabaseResilience] Read failed (${category}/${key}):`, error);
      return fallback;
    }
  }

  /**
   * Execute a write operation with circuit breaker protection.
   * Returns false if write failed, true if succeeded.
   */
  async write<T>(
    category: string,
    writer: () => Promise<T>
  ): Promise<{ success: boolean; data?: T; error?: unknown }> {
    if (!this.supabase) {
      return { success: false, error: 'Supabase not configured' };
    }

    if (this.circuitBreaker.isOpen()) {
      return { success: false, error: 'Circuit breaker open' };
    }

    try {
      const result = await this.circuitBreaker.execute(writer);
      // Invalidate related cache entries on successful write
      this.invalidateCategory(category);
      return { success: true, data: result };
    } catch (error) {
      console.error(`[SupabaseResilience] Write failed (${category}):`, error);
      return { success: false, error };
    }
  }

  /**
   * Execute an RPC call with resilience.
   */
  async rpc<T>(
    name: string,
    params: Record<string, unknown>,
    fallback: T
  ): Promise<T> {
    if (!this.supabase) {
      return fallback;
    }

    if (this.circuitBreaker.isOpen()) {
      return fallback;
    }

    try {
      const result = await this.circuitBreaker.execute(() =>
        this.supabase!.rpc(name, params)
      );
      return (result as { data: T }).data ?? fallback;
    } catch (error) {
      console.error(`[SupabaseResilience] RPC failed (${name}):`, error);
      return fallback;
    }
  }

  // ============================================================
  // Cache Management
  // ============================================================

  private getFromCache<T>(category: string, key: string): T | null {
    const categoryCache = this.cache.get(category);
    if (!categoryCache) return null;

    const entry = categoryCache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      categoryCache.delete(key);
      return null;
    }

    return entry.data;
  }

  private setCache<T>(category: string, key: string, data: T): void {
    let categoryCache = this.cache.get(category);
    if (!categoryCache) {
      categoryCache = new Map();
      this.cache.set(category, categoryCache);
    }

    // Enforce max size (LRU-ish: just delete oldest)
    if (categoryCache.size >= this.config.maxCacheSize) {
      const firstKey = categoryCache.keys().next().value;
      if (firstKey) categoryCache.delete(firstKey);
    }

    categoryCache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: this.config.cacheTtl,
    });
  }

  private invalidateCategory(category: string): void {
    this.cache.delete(category);
  }

  /**
   * Clear all cached data.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { categories: number; totalEntries: number } {
    let totalEntries = 0;
    this.cache.forEach(cat => {
      totalEntries += cat.size;
    });
    return {
      categories: this.cache.size,
      totalEntries,
    };
  }
}

// Global instance - initialized with null, should be set by relay.ts on startup
let globalResilience: SupabaseResilience | null = null;

/**
 * Initialize the global Supabase resilience instance.
 * Should be called once during relay startup.
 */
export function initSupabaseResilience(
  supabase: SupabaseClient | null,
  config?: Partial<ResilienceConfig>
): SupabaseResilience {
  globalResilience = new SupabaseResilience(supabase, {
    ...DEFAULT_CONFIG,
    ...config,
  });
  return globalResilience;
}

/**
 * Get the global Supabase resilience instance.
 * Returns null if not initialized.
 */
export function getSupabaseResilience(): SupabaseResilience | null {
  return globalResilience;
}
