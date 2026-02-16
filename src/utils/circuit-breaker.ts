/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascading failures by temporarily blocking calls to a failing service.
 * States: CLOSED (normal) -> OPEN (failing) -> HALF_OPEN (testing recovery)
 *
 * Usage:
 *   const breaker = new CircuitBreaker('gmail-api', { failureThreshold: 3, resetTimeout: 30000 });
 *   const result = await breaker.execute(() => fetch('https://api.gmail.com/...'));
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting recovery (default: 30000) */
  resetTimeout: number;
  /** Number of successful calls in half-open to close (default: 2) */
  successThreshold: number;
  /** Custom error detector - return true if error should count as failure */
  isFailure?: (error: unknown) => boolean;
  /** Callback when circuit opens */
  onOpen?: (name: string, failures: number) => void;
  /** Callback when circuit closes */
  onClose?: (name: string) => void;
  /** Callback on state change */
  onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;
}

export interface CircuitStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
}

/**
 * Simple in-memory circuit breaker for external API calls.
 *
 * State machine:
 * - CLOSED: Normal operation, all calls pass through
 * - OPEN: Failing, all calls are rejected immediately
 * - HALF_OPEN: Testing if service recovered, limited calls allowed
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;
  private openedAt: Date | null = null;
  private totalCalls = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;

  private readonly options: Required<CircuitBreakerOptions>;

  constructor(
    private readonly name: string,
    options?: Partial<CircuitBreakerOptions>
  ) {
    this.options = {
      failureThreshold: options?.failureThreshold ?? 5,
      resetTimeout: options?.resetTimeout ?? 30000,
      successThreshold: options?.successThreshold ?? 2,
      isFailure: options?.isFailure ?? (() => true),
      onOpen: options?.onOpen ?? ((n, f) => console.log(`[CircuitBreaker:${n}] OPEN after ${f} failures`)),
      onClose: options?.onClose ?? ((n) => console.log(`[CircuitBreaker:${n}] CLOSED - recovered`)),
      onStateChange: options?.onStateChange ?? (() => {}),
    };
  }

  /**
   * Execute a function with circuit breaker protection.
   * Throws CircuitOpenError if circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('half-open');
      } else {
        throw new CircuitOpenError(this.name, this.getTimeUntilReset());
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Check if circuit is currently allowing calls
   */
  isOpen(): boolean {
    if (this.state === 'open') {
      return !this.shouldAttemptReset();
    }
    return false;
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get time in ms until circuit will attempt reset
   */
  getTimeUntilReset(): number {
    if (!this.openedAt) return 0;
    const elapsed = Date.now() - this.openedAt.getTime();
    return Math.max(0, this.options.resetTimeout - elapsed);
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): CircuitStats {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /**
   * Manually reset the circuit (for testing or admin override)
   */
  reset(): void {
    const previousState = this.state;
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    if (previousState !== 'closed') {
      this.options.onStateChange(this.name, previousState, 'closed');
    }
  }

  /**
   * Force open the circuit (for maintenance)
   */
  trip(): void {
    const previousState = this.state;
    this.state = 'open';
    this.openedAt = new Date();
    if (previousState !== 'open') {
      this.options.onStateChange(this.name, previousState, 'open');
      this.options.onOpen(this.name, this.failures);
    }
  }

  private onSuccess(): void {
    this.lastSuccess = new Date();
    this.successes++;
    this.totalSuccesses++;

    if (this.state === 'half-open') {
      if (this.successes >= this.options.successThreshold) {
        this.transitionTo('closed');
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success
      this.failures = 0;
    }
  }

  private onFailure(error: unknown): void {
    if (!this.options.isFailure(error)) {
      return;
    }

    this.lastFailure = new Date();
    this.failures++;
    this.totalFailures++;

    if (this.state === 'half-open') {
      // Failure during half-open -> back to open
      this.transitionTo('open');
      this.options.onOpen(this.name, this.failures);
    } else if (this.state === 'closed') {
      if (this.failures >= this.options.failureThreshold) {
        this.transitionTo('open');
        this.options.onOpen(this.name, this.failures);
      }
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.openedAt) return true;
    return Date.now() - this.openedAt.getTime() >= this.options.resetTimeout;
  }

  private transitionTo(newState: CircuitState): void {
    const previousState = this.state;
    this.state = newState;

    if (newState === 'open') {
      this.openedAt = new Date();
      this.successes = 0;
    } else if (newState === 'closed') {
      this.failures = 0;
      this.successes = 0;
      this.openedAt = null;
      this.options.onClose(this.name);
    } else if (newState === 'half-open') {
      this.successes = 0;
    }

    this.options.onStateChange(this.name, previousState, newState);
  }
}

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly retryAfterMs: number
  ) {
    super(`Circuit "${circuitName}" is open. Retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Registry for managing multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Get or create a circuit breaker
   */
  get(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, options);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /**
   * Get all circuit breaker stats
   */
  getAllStats(): CircuitStats[] {
    return Array.from(this.breakers.values()).map(b => b.getStats());
  }

  /**
   * Check if any circuit is open
   */
  hasOpenCircuits(): boolean {
    return Array.from(this.breakers.values()).some(b => b.isOpen());
  }

  /**
   * Reset all circuits
   */
  resetAll(): void {
    this.breakers.forEach(b => b.reset());
  }
}

// Global registry instance
export const circuitBreakers = new CircuitBreakerRegistry();
