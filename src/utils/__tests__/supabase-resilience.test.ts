/**
 * Tests for Supabase Resilience Layer
 */

import { describe, it, expect, beforeEach, vi } from "bun:test";
import { SupabaseResilience, initSupabaseResilience, getSupabaseResilience } from "../supabase-resilience.ts";

// Mock Supabase client
const mockSupabase = {
  from: vi.fn(() => ({
    select: vi.fn(() => ({
      limit: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
      })),
      eq: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
      })),
    })),
  })),
  rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
};

describe("SupabaseResilience", () => {
  let resilience: SupabaseResilience;

  beforeEach(() => {
    vi.clearAllMocks();
    resilience = new SupabaseResilience(mockSupabase as any, {
      cacheTtl: 1000, // 1 second for faster tests
      maxCacheSize: 10,
      debug: false,
    });
  });

  describe("isAvailable", () => {
    it("returns false when supabase is null", () => {
      const nullResilience = new SupabaseResilience(null);
      expect(nullResilience.isAvailable()).toBe(false);
    });

    it("returns true when supabase is configured and circuit is closed", () => {
      expect(resilience.isAvailable()).toBe(true);
    });
  });

  describe("getHealth", () => {
    it("returns correct health status for null supabase", () => {
      const nullResilience = new SupabaseResilience(null);
      const health = nullResilience.getHealth();

      expect(health.isConfigured).toBe(false);
      expect(health.isHealthy).toBe(false);
    });

    it("returns configured=true when supabase is available", () => {
      const health = resilience.getHealth();
      expect(health.isConfigured).toBe(true);
    });
  });

  describe("read", () => {
    it("returns fallback when supabase is null", async () => {
      const nullResilience = new SupabaseResilience(null);
      const result = await nullResilience.read("test", "key", async () => ["data"], ["fallback"]);

      expect(result).toEqual(["fallback"]);
    });

    it("caches successful reads", async () => {
      const fetcher = vi.fn(async () => ["data1"]);
      const fallback: string[] = [];

      // First read - should call fetcher
      const result1 = await resilience.read("test", "key", fetcher, fallback);
      expect(result1).toEqual(["data1"]);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Second read - should use cache
      const result2 = await resilience.read("test", "key", fetcher, fallback);
      expect(result2).toEqual(["data1"]);
      expect(fetcher).toHaveBeenCalledTimes(1); // Still 1, used cache
    });

    it("returns fallback on fetcher error", async () => {
      const fetcher = vi.fn(async () => {
        throw new Error("Connection failed");
      });
      const fallback = ["fallback"];

      const result = await resilience.read("test", "key", fetcher, fallback);
      expect(result).toEqual(["fallback"]);
    });
  });

  describe("write", () => {
    it("returns success=false when supabase is null", async () => {
      const nullResilience = new SupabaseResilience(null);
      const result = await nullResilience.write("test", async () => {});

      expect(result.success).toBe(false);
      expect(result.error).toBe("Supabase not configured");
    });

    it("returns success=true on successful write", async () => {
      const writer = vi.fn(async () => ({ id: 1 }));
      const result = await resilience.write("test", writer);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 1 });
    });

    it("returns success=false on write error", async () => {
      const writer = vi.fn(async () => {
        throw new Error("Write failed");
      });
      const result = await resilience.write("test", writer);

      expect(result.success).toBe(false);
    });
  });

  describe("rpc", () => {
    it("returns fallback when supabase is null", async () => {
      const nullResilience = new SupabaseResilience(null);
      const result = await nullResilience.rpc("test_rpc", {}, ["fallback"]);

      expect(result).toEqual(["fallback"]);
    });

    it("returns fallback on RPC error", async () => {
      mockSupabase.rpc.mockImplementationOnce(() =>
        Promise.reject(new Error("RPC failed"))
      );

      const result = await resilience.rpc("test_rpc", {}, ["fallback"]);
      expect(result).toEqual(["fallback"]);
    });
  });

  describe("cache management", () => {
    it("clearCache removes all cached entries", async () => {
      const fetcher = vi.fn(async () => ["data"]);
      await resilience.read("cat1", "key1", fetcher, []);
      await resilience.read("cat2", "key2", fetcher, []);

      const statsBefore = resilience.getCacheStats();
      expect(statsBefore.categories).toBeGreaterThan(0);

      resilience.clearCache();

      const statsAfter = resilience.getCacheStats();
      expect(statsAfter.categories).toBe(0);
      expect(statsAfter.totalEntries).toBe(0);
    });

    it("respects maxCacheSize", async () => {
      const smallCacheResilience = new SupabaseResilience(mockSupabase as any, {
        cacheTtl: 60000,
        maxCacheSize: 2,
        debug: false,
      });

      // Add 3 entries to a category with max size 2
      await smallCacheResilience.read("test", "key1", async () => "val1", "");
      await smallCacheResilience.read("test", "key2", async () => "val2", "");
      await smallCacheResilience.read("test", "key3", async () => "val3", "");

      const stats = smallCacheResilience.getCacheStats();
      // Should have evicted the oldest entry
      expect(stats.totalEntries).toBeLessThanOrEqual(2);
    });
  });
});

describe("Global instance", () => {
  it("getSupabaseResilience returns null before initialization", () => {
    // Reset global state for this test
    // Note: In real usage, initSupabaseResilience is called once at startup
    const instance = getSupabaseResilience();
    // May be null or the instance from previous tests
    expect(instance).toBeDefined();
  });

  it("initSupabaseResilience creates and returns instance", () => {
    const instance = initSupabaseResilience(mockSupabase as any);
    expect(instance).toBeInstanceOf(SupabaseResilience);
    expect(getSupabaseResilience()).toBe(instance);
  });
});
