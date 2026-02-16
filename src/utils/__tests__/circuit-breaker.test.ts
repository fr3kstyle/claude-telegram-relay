import { describe, it, expect, beforeEach } from 'bun:test';
import { CircuitBreaker, CircuitOpenError, CircuitBreakerRegistry } from '../circuit-breaker.ts';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeout: 100, // Fast for tests
      successThreshold: 2,
    });
  });

  describe('initial state', () => {
    it('starts in closed state', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('is not open initially', () => {
      expect(breaker.isOpen()).toBe(false);
    });
  });

  describe('closed state', () => {
    it('passes through successful calls', async () => {
      const result = await breaker.execute(() => Promise.resolve('success'));
      expect(result).toBe('success');
    });

    it('counts failures but stays closed under threshold', async () => {
      const failingFn = () => Promise.reject(new Error('fail'));

      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }

      expect(breaker.getState()).toBe('closed');
      const stats = breaker.getStats();
      expect(stats.failures).toBe(2);
    });

    it('opens after reaching failure threshold', async () => {
      const failingFn = () => Promise.reject(new Error('fail'));

      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }

      expect(breaker.getState()).toBe('open');
      expect(breaker.isOpen()).toBe(true);
    });

    it('resets failure count on success', async () => {
      const failingFn = () => Promise.reject(new Error('fail'));

      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      expect(breaker.getStats().failures).toBe(1);

      await breaker.execute(() => Promise.resolve('success'));
      expect(breaker.getStats().failures).toBe(0);
    });
  });

  describe('open state', () => {
    beforeEach(async () => {
      // Trip the breaker
      const failingFn = () => Promise.reject(new Error('fail'));
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
    });

    it('rejects calls immediately when open', async () => {
      let threw = false;
      try {
        await breaker.execute(() => Promise.resolve('success'));
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(CircuitOpenError);
      }
      expect(threw).toBe(true);
    });

    it('includes retry time in error', async () => {
      try {
        await breaker.execute(() => Promise.resolve('success'));
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        expect((error as CircuitOpenError).circuitName).toBe('test');
        expect((error as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      }
    });

    it('transitions to half-open after reset timeout', async () => {
      expect(breaker.getState()).toBe('open');

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      // Next call should be allowed (half-open)
      const result = await breaker.execute(() => Promise.resolve('success'));
      expect(result).toBe('success');
      expect(breaker.getState()).toBe('half-open');
    });
  });

  describe('half-open state', () => {
    beforeEach(async () => {
      // Trip the breaker
      const failingFn = () => Promise.reject(new Error('fail'));
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }
      try { await breaker.execute(failingFn); } catch (e) { /* expected */ }

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    it('closes after enough successes', async () => {
      expect(breaker.getState()).toBe('open'); // Will transition to half-open on next call

      await breaker.execute(() => Promise.resolve('success1'));
      expect(breaker.getState()).toBe('half-open');

      await breaker.execute(() => Promise.resolve('success2'));
      expect(breaker.getState()).toBe('closed');
    });

    it('reopens on failure in half-open', async () => {
      await breaker.execute(() => Promise.resolve('success'));
      expect(breaker.getState()).toBe('half-open');

      try {
        await breaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) { /* expected */ }
      expect(breaker.getState()).toBe('open');
    });
  });

  describe('callbacks', () => {
    it('calls onOpen when circuit opens', async () => {
      let openCalled = false;
      let openFailures = 0;
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        onOpen: (_name, failures) => {
          openCalled = true;
          openFailures = failures;
        }
      });

      try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }
      try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }

      expect(openCalled).toBe(true);
      expect(openFailures).toBe(2);
    });

    it('calls onClose when circuit closes', async () => {
      let closeCalled = false;
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeout: 50,
        successThreshold: 1,
        onClose: () => { closeCalled = true; }
      });

      // Open it
      try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }
      expect(cb.getState()).toBe('open');

      // Wait and recover
      await new Promise(resolve => setTimeout(resolve, 100));
      await cb.execute(() => Promise.resolve('success'));

      expect(closeCalled).toBe(true);
    });
  });

  describe('stats', () => {
    it('tracks statistics correctly', async () => {
      await breaker.execute(() => Promise.resolve('ok'));
      try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }
      await breaker.execute(() => Promise.resolve('ok2'));

      const stats = breaker.getStats();
      expect(stats.name).toBe('test');
      expect(stats.state).toBe('closed');
      expect(stats.totalCalls).toBe(3);
      expect(stats.totalSuccesses).toBe(2);
      expect(stats.totalFailures).toBe(1);
      expect(stats.lastFailure).toBeInstanceOf(Date);
      expect(stats.lastSuccess).toBeInstanceOf(Date);
    });
  });

  describe('manual control', () => {
    it('reset() forces closed state', async () => {
      // Trip it
      try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }
      try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }
      try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }
      expect(breaker.getState()).toBe('open');

      breaker.reset();
      expect(breaker.getState()).toBe('closed');
      expect(breaker.isOpen()).toBe(false);
    });

    it('trip() forces open state', () => {
      expect(breaker.getState()).toBe('closed');

      breaker.trip();
      expect(breaker.getState()).toBe('open');
      expect(breaker.isOpen()).toBe(true);
    });
  });

  describe('isFailure filter', () => {
    it('only counts matching errors as failures', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        isFailure: (err) => {
          // Only count 5xx errors as failures
          const msg = err instanceof Error ? err.message : String(err);
          return msg.includes('5');
        }
      });

      // These don't count
      try { await cb.execute(() => Promise.reject(new Error('400 bad request'))); } catch (e) { /* expected */ }
      try { await cb.execute(() => Promise.reject(new Error('401 unauthorized'))); } catch (e) { /* expected */ }
      expect(cb.getState()).toBe('closed');

      // These count
      try { await cb.execute(() => Promise.reject(new Error('500 server error'))); } catch (e) { /* expected */ }
      try { await cb.execute(() => Promise.reject(new Error('503 unavailable'))); } catch (e) { /* expected */ }
      expect(cb.getState()).toBe('open');
    });
  });
});

describe('CircuitBreakerRegistry', () => {
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry();
  });

  it('creates and returns same breaker for same name', () => {
    const b1 = registry.get('api1');
    const b2 = registry.get('api1');
    expect(b1).toBe(b2);
  });

  it('creates different breakers for different names', () => {
    const b1 = registry.get('api1');
    const b2 = registry.get('api2');
    expect(b1).not.toBe(b2);
  });

  it('getAllStats returns all breaker stats', async () => {
    const b1 = registry.get('api1', { failureThreshold: 1 });
    const b2 = registry.get('api2');

    await b1.execute(() => Promise.resolve('ok'));

    const stats = registry.getAllStats();
    expect(stats).toHaveLength(2);
    expect(stats.find(s => s.name === 'api1')?.totalCalls).toBe(1);
    expect(stats.find(s => s.name === 'api2')?.totalCalls).toBe(0);
  });

  it('hasOpenCircuits detects open circuits', async () => {
    const b1 = registry.get('api1', { failureThreshold: 1 });

    expect(registry.hasOpenCircuits()).toBe(false);

    try { await b1.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }

    expect(registry.hasOpenCircuits()).toBe(true);
  });

  it('resetAll resets all circuits', async () => {
    const b1 = registry.get('api1', { failureThreshold: 1 });
    const b2 = registry.get('api2', { failureThreshold: 1 });

    try { await b1.execute(() => Promise.reject(new Error('fail'))); } catch (e) { /* expected */ }
    b2.trip();

    expect(registry.hasOpenCircuits()).toBe(true);

    registry.resetAll();

    expect(b1.isOpen()).toBe(false);
    expect(b2.isOpen()).toBe(false);
  });
});

describe('CircuitOpenError', () => {
  it('has correct properties', () => {
    const error = new CircuitOpenError('my-api', 5000);
    expect(error.name).toBe('CircuitOpenError');
    expect(error.circuitName).toBe('my-api');
    expect(error.retryAfterMs).toBe(5000);
    expect(error.message).toContain('my-api');
    expect(error.message).toContain('5s');
  });
});
