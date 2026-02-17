/**
 * Rate Limit Tracker
 *
 * Tracks API rate limits across multiple providers with per-provider configuration.
 * Parses rate limit headers from API responses and provides consumption warnings.
 *
 * Usage:
 *   const tracker = rateLimitTrackers.get('gmail-api', {
 *     headerLimit: 'x-ratelimit-limit',
 *     headerRemaining: 'x-ratelimit-remaining',
 *     warningThreshold: 0.2, // Warn at 20% remaining
 *   });
 *
 *   // After API response:
 *   tracker.updateFromHeaders(response.headers);
 *
 *   // Check before making calls:
 *   if (tracker.isLow()) {
 *     console.warn('Rate limit low:', tracker.getStatus());
 *   }
 */

export interface RateLimitConfig {
  /** Header name for total limit (e.g., 'x-ratelimit-limit') */
  headerLimit: string;
  /** Header name for remaining (e.g., 'x-ratelimit-remaining') */
  headerRemaining: string;
  /** Header name for reset time in seconds (optional) */
  headerReset?: string;
  /** Alternative header names to check (for providers with different headers) */
  altHeaders?: {
    limit?: string;
    remaining?: string;
    reset?: string;
  };
  /** Fraction of limit remaining to trigger warning (default: 0.2 = 20%) */
  warningThreshold: number;
  /** Fraction of limit remaining to trigger critical (default: 0.05 = 5%) */
  criticalThreshold: number;
  /** Callback when entering warning state */
  onWarning?: (name: string, remaining: number, limit: number) => void;
  /** Callback when entering critical state */
  onCritical?: (name: string, remaining: number, limit: number) => void;
}

export interface RateLimitStatus {
  name: string;
  limit: number | null;
  remaining: number | null;
  used: number;
  resetAt: Date | null;
  lastUpdated: Date | null;
  percentRemaining: number | null;
  state: 'ok' | 'warning' | 'critical' | 'unknown';
}

export interface RateLimitStats {
  totalCalls: number;
  headerParseErrors: number;
  warningEvents: number;
  criticalEvents: number;
}

const DEFAULT_CONFIG: Omit<RateLimitConfig, 'headerLimit' | 'headerRemaining'> = {
  warningThreshold: 0.2,
  criticalThreshold: 0.05,
};

/**
 * Tracks rate limits for a single API provider
 */
export class RateLimitTracker {
  private limit: number | null = null;
  private remaining: number | null = null;
  private resetAt: Date | null = null;
  private lastUpdated: Date | null = null;
  private lastState: 'ok' | 'warning' | 'critical' | 'unknown' = 'unknown';

  private totalCalls = 0;
  private headerParseErrors = 0;
  private warningEvents = 0;
  private criticalEvents = 0;

  private readonly config: RateLimitConfig;

  constructor(
    private readonly name: string,
    config: Partial<RateLimitConfig> & { headerLimit: string; headerRemaining: string }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update rate limit state from response headers
   */
  updateFromHeaders(headers: Headers): void {
    this.totalCalls++;

    const limit = this.parseHeader(headers, 'limit');
    const remaining = this.parseHeader(headers, 'remaining');
    const reset = this.parseHeader(headers, 'reset');

    if (limit !== null) this.limit = limit;
    if (remaining !== null) this.remaining = remaining;

    if (reset !== null) {
      // Reset is typically seconds until reset
      this.resetAt = new Date(Date.now() + reset * 1000);
    }

    this.lastUpdated = new Date();
    this.checkThresholds();
  }

  /**
   * Manually update rate limit values (for APIs that don't use headers)
   */
  update(limit: number, remaining: number, resetInSeconds?: number): void {
    this.totalCalls++;
    this.limit = limit;
    this.remaining = remaining;

    if (resetInSeconds !== undefined) {
      this.resetAt = new Date(Date.now() + resetInSeconds * 1000);
    }

    this.lastUpdated = new Date();
    this.checkThresholds();
  }

  /**
   * Get current rate limit status
   */
  getStatus(): RateLimitStatus {
    const percentRemaining = this.getPercentRemaining();
    const state = this.getState(percentRemaining);

    return {
      name: this.name,
      limit: this.limit,
      remaining: this.remaining,
      used: this.limit !== null && this.remaining !== null
        ? this.limit - this.remaining
        : 0,
      resetAt: this.resetAt,
      lastUpdated: this.lastUpdated,
      percentRemaining,
      state,
    };
  }

  /**
   * Check if rate limit is in warning or critical state
   */
  isLow(): boolean {
    const percent = this.getPercentRemaining();
    return percent !== null && percent < this.config.warningThreshold;
  }

  /**
   * Check if rate limit is in critical state
   */
  isCritical(): boolean {
    const percent = this.getPercentRemaining();
    return percent !== null && percent < this.config.criticalThreshold;
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): RateLimitStats {
    return {
      totalCalls: this.totalCalls,
      headerParseErrors: this.headerParseErrors,
      warningEvents: this.warningEvents,
      criticalEvents: this.criticalEvents,
    };
  }

  /**
   * Get time in ms until rate limit resets.
   * Returns null if reset time is unknown.
   */
  getTimeUntilReset(): number | null {
    if (!this.resetAt) return null;
    const remaining = this.resetAt.getTime() - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Wait until rate limit resets (if we have reset time).
   * Returns immediately if no reset time known or already past.
   */
  async waitForReset(): Promise<void> {
    const waitMs = this.getTimeUntilReset();
    if (waitMs === null || waitMs === 0) return;

    console.log(`[RateLimitTracker:${this.name}] Waiting ${Math.ceil(waitMs / 1000)}s for rate limit reset`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.limit = null;
    this.remaining = null;
    this.resetAt = null;
    this.lastUpdated = null;
    this.lastState = 'unknown';
  }

  // --- Private helpers ---

  private parseHeader(headers: Headers, type: 'limit' | 'remaining' | 'reset'): number | null {
    let headerName: string;

    if (type === 'limit') {
      headerName = this.config.headerLimit;
    } else if (type === 'remaining') {
      headerName = this.config.headerRemaining;
    } else {
      headerName = this.config.headerReset || '';
    }

    // Try primary header
    let value = headers.get(headerName);

    // Try alternative headers if configured and primary not found
    if (value === null && this.config.altHeaders) {
      const altKey = type === 'limit' ? 'limit' : type === 'remaining' ? 'remaining' : 'reset';
      const altHeader = this.config.altHeaders[altKey];
      if (altHeader) {
        value = headers.get(altHeader);
      }
    }

    if (value === null) {
      return null;
    }

    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      this.headerParseErrors++;
      return null;
    }

    return parsed;
  }

  private getPercentRemaining(): number | null {
    if (this.limit === null || this.remaining === null || this.limit === 0) {
      return null;
    }
    return this.remaining / this.limit;
  }

  private getState(percent: number | null): 'ok' | 'warning' | 'critical' | 'unknown' {
    if (percent === null) return 'unknown';
    if (percent < this.config.criticalThreshold) return 'critical';
    if (percent < this.config.warningThreshold) return 'warning';
    return 'ok';
  }

  private checkThresholds(): void {
    const percent = this.getPercentRemaining();
    if (percent === null) return;

    const newState = this.getState(percent);

    // Only fire callbacks on state transitions
    if (newState !== this.lastState) {
      if (newState === 'warning' && this.config.onWarning) {
        this.warningEvents++;
        this.config.onWarning(this.name, this.remaining!, this.limit!);
      } else if (newState === 'critical' && this.config.onCritical) {
        this.criticalEvents++;
        this.config.onCritical(this.name, this.remaining!, this.limit!);
      }
    }

    this.lastState = newState;
  }
}

/**
 * Registry for managing multiple rate limit trackers
 */
export class RateLimitTrackerRegistry {
  private trackers = new Map<string, RateLimitTracker>();

  /**
   * Get or create a rate limit tracker
   */
  get(name: string, config: Partial<RateLimitConfig> & { headerLimit: string; headerRemaining: string }): RateLimitTracker {
    let tracker = this.trackers.get(name);
    if (!tracker) {
      tracker = new RateLimitTracker(name, config);
      this.trackers.set(name, tracker);
    }
    return tracker;
  }

  /**
   * Get all tracker statuses
   */
  getAllStatuses(): RateLimitStatus[] {
    return Array.from(this.trackers.values()).map(t => t.getStatus());
  }

  /**
   * Get statuses that are in warning or critical state
   */
  getLowLimits(): RateLimitStatus[] {
    return this.getAllStatuses().filter(s => s.state === 'warning' || s.state === 'critical');
  }

  /**
   * Check if any tracker is in critical state
   */
  hasCriticalLimits(): boolean {
    return this.getAllStatuses().some(s => s.state === 'critical');
  }

  /**
   * Reset all trackers
   */
  resetAll(): void {
    this.trackers.forEach(t => t.reset());
  }
}

/**
 * Predefined configurations for known providers.
 * These can be used as defaults when creating trackers.
 */
export const PROVIDER_PRESETS: Record<string, Partial<RateLimitConfig>> = {
  'gmail-api': {
    headerLimit: 'x-ratelimit-limit',
    headerRemaining: 'x-ratelimit-remaining',
    warningThreshold: 0.2,
    criticalThreshold: 0.05,
  },
  'outlook-graph': {
    headerLimit: 'x-ratelimit-limit',
    headerRemaining: 'x-ratelimit-remaining',
    altHeaders: {
      limit: 'ratecontrol-limit',
      remaining: 'ratecontrol-remaining',
    },
    warningThreshold: 0.2,
    criticalThreshold: 0.05,
  },
  'groq-whisper': {
    headerLimit: 'x-ratelimit-limit-requests',
    headerRemaining: 'x-ratelimit-remaining-requests',
    warningThreshold: 0.3,
    criticalThreshold: 0.1,
  },
  'elevenlabs-tts': {
    headerLimit: 'x-ratelimit-limit',
    headerRemaining: 'x-ratelimit-remaining',
    warningThreshold: 0.25,
    criticalThreshold: 0.1,
  },
};

// Global registry instance
export const rateLimitTrackers = new RateLimitTrackerRegistry();

/**
 * Get or create a tracker with a provider preset.
 * Convenience function that merges preset with custom config.
 */
export function getRateLimitTracker(
  name: string,
  customConfig?: Partial<RateLimitConfig>
): RateLimitTracker {
  const preset = PROVIDER_PRESETS[name] || {};
  const config = {
    headerLimit: customConfig?.headerLimit || preset.headerLimit || 'x-ratelimit-limit',
    headerRemaining: customConfig?.headerRemaining || preset.headerRemaining || 'x-ratelimit-remaining',
    ...preset,
    ...customConfig,
  };
  return rateLimitTrackers.get(name, config as Required<typeof config>);
}
