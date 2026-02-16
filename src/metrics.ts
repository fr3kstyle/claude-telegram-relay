/**
 * Metrics & Telemetry Module
 *
 * Tracks performance metrics and generates reports:
 * - Token usage
 * - Cost estimates
 * - Action success rate
 * - Retry counts
 * - Execution times
 *
 * Run: bun run src/metrics.ts
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const METRICS_FILE = join(RELAY_DIR, "metrics.json");

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// METRICS TYPES
// ============================================================

interface MetricEvent {
  timestamp: string;
  type: "action" | "goal" | "cycle" | "error" | "token";
  success: boolean;
  duration_ms?: number;
  tokens_used?: number;
  error?: string;
}

interface MetricsSnapshot {
  period_start: string;
  period_end: string;
  total_events: number;
  success_rate: number;
  avg_duration_ms: number;
  total_tokens: number;
  estimated_cost_usd: number;
  retry_count: number;
  error_count: number;
  by_type: Record<string, { count: number; success_rate: number }>;
}

interface MetricsState {
  events: MetricEvent[];
  last_report: string;
  total_tokens: number;
  total_cost_usd: number;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

async function loadState(): Promise<MetricsState> {
  try {
    const content = await readFile(METRICS_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      events: [],
      last_report: "",
      total_tokens: 0,
      total_cost_usd: 0,
    };
  }
}

async function saveState(state: MetricsState): Promise<void> {
  await writeFile(METRICS_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// METRICS RECORDING
// ============================================================

export async function recordMetric(event: Omit<MetricEvent, "timestamp">): Promise<void> {
  const state = await loadState();
  
  const fullEvent: MetricEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  
  state.events.push(fullEvent);
  
  // Update totals
  if (event.tokens_used) {
    state.total_tokens += event.tokens_used;
    // Estimate cost: ~$0.003 per 1k input tokens, ~$0.015 per 1k output tokens
    // Average assumption: 50/50 split
    state.total_cost_usd += (event.tokens_used / 1000) * 0.009;
  }
  
  // Keep only last 1000 events
  if (state.events.length > 1000) {
    state.events = state.events.slice(-1000);
  }
  
  await saveState(state);
}

export function recordAction(success: boolean, durationMs: number): Promise<void> {
  return recordMetric({ type: "action", success, duration_ms: durationMs });
}

export function recordCycle(success: boolean, durationMs: number, tokensUsed?: number): Promise<void> {
  return recordMetric({ type: "cycle", success, duration_ms: durationMs, tokens_used: tokensUsed });
}

export function recordError(error: string): Promise<void> {
  return recordMetric({ type: "error", success: false, error });
}

// ============================================================
// METRICS ANALYSIS
// ============================================================

export async function generateSnapshot(periodHours: number = 24): Promise<MetricsSnapshot> {
  const state = await loadState();
  const now = new Date();
  const periodStart = new Date(now.getTime() - periodHours * 60 * 60 * 1000);
  
  const periodEvents = state.events.filter(
    e => new Date(e.timestamp) >= periodStart
  );
  
  const successfulEvents = periodEvents.filter(e => e.success);
  const successRate = periodEvents.length > 0 
    ? successfulEvents.length / periodEvents.length 
    : 0;
  
  const durations = periodEvents
    .filter(e => e.duration_ms)
    .map(e => e.duration_ms!);
  
  const avgDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;
  
  const tokens = periodEvents
    .filter(e => e.tokens_used)
    .reduce((sum, e) => sum + (e.tokens_used || 0), 0);
  
  const cost = (tokens / 1000) * 0.009;
  
  const retries = periodEvents.filter(e => !e.success && e.type !== "error").length;
  const errors = periodEvents.filter(e => e.type === "error").length;
  
  // By type breakdown
  const byType: Record<string, { count: number; success_rate: number }> = {};
  for (const event of periodEvents) {
    if (!byType[event.type]) {
      byType[event.type] = { count: 0, success_rate: 0 };
    }
    byType[event.type].count++;
  }
  
  for (const type of Object.keys(byType)) {
    const typeEvents = periodEvents.filter(e => e.type === type);
    const typeSuccess = typeEvents.filter(e => e.success).length;
    byType[type].success_rate = typeEvents.length > 0 
      ? typeSuccess / typeEvents.length 
      : 0;
  }
  
  return {
    period_start: periodStart.toISOString(),
    period_end: now.toISOString(),
    total_events: periodEvents.length,
    success_rate: successRate,
    avg_duration_ms: Math.round(avgDuration),
    total_tokens: tokens,
    estimated_cost_usd: Math.round(cost * 100) / 100,
    retry_count: retries,
    error_count: errors,
    by_type: byType,
  };
}

// ============================================================
// REPORTING
// ============================================================

export async function generateWeeklyReport(): Promise<string> {
  const snapshot = await generateSnapshot(168); // 7 days
  
  const lines = [
    "# WEEKLY PERFORMANCE REPORT",
    "",
    `Period: ${new Date(snapshot.period_start).toLocaleDateString()} - ${new Date(snapshot.period_end).toLocaleDateString()}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Events | ${snapshot.total_events} |`,
    `| Success Rate | ${(snapshot.success_rate * 100).toFixed(1)}% |`,
    `| Avg Duration | ${snapshot.avg_duration_ms}ms |`,
    `| Total Tokens | ${snapshot.total_tokens.toLocaleString()} |`,
    `| Est. Cost | $${snapshot.estimated_cost_usd.toFixed(2)} |`,
    `| Retries | ${snapshot.retry_count} |`,
    `| Errors | ${snapshot.error_count} |`,
    "",
    "## By Type",
    "",
  ];
  
  for (const [type, data] of Object.entries(snapshot.by_type)) {
    lines.push(`- ${type}: ${data.count} events (${(data.success_rate * 100).toFixed(0)}% success)`);
  }
  
  return lines.join("\n");
}

export async function storeReportToMemory(): Promise<void> {
  if (!supabase) return;
  
  const report = await generateWeeklyReport();
  
  await supabase.from("memory").insert({
    type: "system_event",
    content: `Weekly Metrics Report: ${(await generateSnapshot()).total_events} events, ${(await generateSnapshot()).success_rate * 100}% success`,
    metadata: { report },
    status: "active",
  });
}

// ============================================================
// TELEGRAM NOTIFICATION
// ============================================================

async function sendTelegramReport(report: string): Promise<boolean> {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_USER_ID;
  
  if (!BOT_TOKEN || !CHAT_ID) return false;
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: report,
          parse_mode: "Markdown",
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("[METRICS] Generating performance report...\n");
  
  const snapshot = await generateSnapshot();
  
  console.log("## 24-Hour Metrics");
  console.log(`- Events: ${snapshot.total_events}`);
  console.log(`- Success Rate: ${(snapshot.success_rate * 100).toFixed(1)}%`);
  console.log(`- Avg Duration: ${snapshot.avg_duration_ms}ms`);
  console.log(`- Tokens: ${snapshot.total_tokens}`);
  console.log(`- Est. Cost: $${snapshot.estimated_cost_usd.toFixed(2)}`);
  console.log(`- Retries: ${snapshot.retry_count}`);
  console.log(`- Errors: ${snapshot.error_count}`);
  
  console.log("\n## By Type");
  for (const [type, data] of Object.entries(snapshot.by_type)) {
    console.log(`- ${type}: ${data.count} (${(data.success_rate * 100).toFixed(0)}%)`);
  }
}

main().catch(console.error);
