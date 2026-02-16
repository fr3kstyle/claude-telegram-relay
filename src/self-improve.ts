/**
 * Self-Improvement Module v1.0
 *
 * Implements continuous self-improvement through:
 * - A/B testing of strategies
 * - Metrics tracking and analysis
 * - Automated learning from failures
 * - Performance baseline comparisons
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Types
interface ABTest {
  id: string;
  name: string;
  variant_a: string;
  variant_b: string;
  metric: string;
  status: "running" | "completed" | "paused";
  created_at: string;
  completed_at?: string;
  winner?: "a" | "b" | "tie";
}

interface Metric {
  id: string;
  category: string;
  name: string;
  value: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface ImprovementLog {
  id: string;
  type: "insight" | "failure" | "success" | "experiment";
  description: string;
  impact: "low" | "medium" | "high";
  action_taken?: string;
  created_at: string;
}

// A/B Testing Framework
export async function createABTest(
  name: string,
  variantA: string,
  variantB: string,
  metric: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("self_improvement_tests")
    .insert({
      name,
      variant_a: variantA,
      variant_b: variantB,
      metric,
      status: "running",
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to create A/B test:", error);
    return null;
  }

  // Log as memory
  await supabase.from("memory").insert({
    type: "action",
    content: `[SELF-IMPROVE] A/B Test started: ${name}`,
    status: "pending",
    priority: 2,
  });

  return data.id;
}

export async function recordTestResult(
  testId: string,
  variant: "a" | "b",
  success: boolean,
  value?: number
): Promise<void> {
  const column = variant === "a" ? "results_a" : "results_b";

  // Get current results
  const { data: test } = await supabase
    .from("self_improvement_tests")
    .select(column)
    .eq("id", testId)
    .single();

  const currentResults = test?.[column] || { successes: 0, failures: 0, total_value: 0 };

  const newResults = {
    successes: currentResults.successes + (success ? 1 : 0),
    failures: currentResults.failures + (success ? 0 : 1),
    total_value: currentResults.total_value + (value || 0),
  };

  await supabase
    .from("self_improvement_tests")
    .update({ [column]: newResults })
    .eq("id", testId);
}

export async function analyzeTestResults(testId: string): Promise<{
  winner: "a" | "b" | "tie";
  confidence: number;
  recommendation: string;
} | null> {
  const { data: test } = await supabase
    .from("self_improvement_tests")
    .select("*")
    .eq("id", testId)
    .single();

  if (!test) return null;

  const a = test.results_a || { successes: 0, failures: 0 };
  const b = test.results_b || { successes: 0, failures: 0 };

  const rateA = a.successes / Math.max(1, a.successes + a.failures);
  const rateB = b.successes / Math.max(1, b.successes + b.failures);

  const totalSamples = a.successes + a.failures + b.successes + b.failures;

  // Simple statistical significance (needs 30+ samples per variant for confidence)
  const confidence = Math.min(1, totalSamples / 60);

  let winner: "a" | "b" | "tie" = "tie";
  if (rateA > rateB + 0.1) winner = "a";
  else if (rateB > rateA + 0.1) winner = "b";

  const recommendation =
    winner === "tie"
      ? "Continue testing or declare tie"
      : `Adopt variant ${winner.toUpperCase()}: ${test[`variant_${winner}`]}`;

  // Update test if we have enough confidence
  if (confidence >= 0.8) {
    await supabase
      .from("self_improvement_tests")
      .update({
        status: "completed",
        winner,
        completed_at: new Date().toISOString(),
      })
      .eq("id", testId);
  }

  return { winner, confidence, recommendation };
}

// Metrics Tracking
export async function recordMetric(
  category: string,
  name: string,
  value: number,
  metadata?: Record<string, unknown>
): Promise<void> {
  await supabase.from("improvement_metrics").insert({
    category,
    name,
    value,
    metadata,
  });
}

export async function getMetricBaseline(
  category: string,
  name: string,
  days: number = 30
): Promise<{ avg: number; min: number; max: number; trend: number } | null> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data } = await supabase
    .from("improvement_metrics")
    .select("value, timestamp")
    .eq("category", category)
    .eq("name", name)
    .gte("timestamp", since.toISOString())
    .order("timestamp", { ascending: true });

  if (!data || data.length === 0) return null;

  const values = data.map((d) => d.value);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Simple trend: compare first half to second half
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const secondHalf = values.slice(mid).reduce((a, b) => a + b, 0) / (values.length - mid);
  const trend = secondHalf - firstHalf;

  return { avg, min, max, trend };
}

// Failure Learning
export async function logFailure(
  description: string,
  error: string,
  context?: Record<string, unknown>
): Promise<void> {
  // Log the failure
  await supabase.from("improvement_logs").insert({
    type: "failure",
    description: `${description}: ${error}`,
    impact: "medium",
    metadata: context,
  });

  // Create memory to prevent future occurrences
  await supabase.from("memory").insert({
    type: "reflection",
    content: `[FAILURE-LEARNING] ${description}. Error: ${error}. Prevent recurrence.`,
    status: "active",
  });
}

export async function logSuccess(
  description: string,
  impact: "low" | "medium" | "high",
  reusable?: string
): Promise<void> {
  await supabase.from("improvement_logs").insert({
    type: "success",
    description,
    impact,
    action_taken: reusable,
  });

  if (reusable) {
    await supabase.from("memory").insert({
      type: "strategy",
      content: `[SUCCESS-PATTERN] ${reusable}`,
      status: "active",
    });
  }
}

// Self-Assessment
export async function performSelfAssessment(): Promise<{
  score: number;
  areas: Record<string, number>;
  recommendations: string[];
}> {
  const areas: Record<string, number> = {};
  const recommendations: string[] = [];

  // 1. Memory Quality (0-100)
  const { count: totalMemories } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true });

  const { count: withEmbeddings } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .not("embedding", "is", null);

  const memoryQuality = totalMemories ? ((withEmbeddings || 0) / totalMemories) * 100 : 0;
  areas["memory_quality"] = Math.round(memoryQuality);
  if (memoryQuality < 80) recommendations.push("Backfill missing embeddings for better recall");

  // 2. Goal Progress (0-100)
  const { data: activeGoals } = await supabase
    .from("memory")
    .select("id, status, created_at")
    .eq("type", "goal")
    .eq("status", "active");

  const totalGoals = activeGoals?.length || 0;
  const goalsScore = Math.max(0, 100 - totalGoals * 5); // Fewer active goals = better (completed)
  areas["goal_progress"] = goalsScore;
  if (totalGoals > 10) recommendations.push("Consider breaking down or completing stale goals");

  // 3. System Reliability (0-100)
  const { count: recentFailures } = await supabase
    .from("improvement_logs")
    .select("*", { count: "exact", head: true })
    .eq("type", "failure")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  const reliability = Math.max(0, 100 - (recentFailures || 0) * 10);
  areas["system_reliability"] = reliability;
  if (recentFailures && recentFailures > 3) recommendations.push("Review recent failures for patterns");

  // 4. Active Improvement (0-100)
  const { count: activeTests } = await supabase
    .from("self_improvement_tests")
    .select("*", { count: "exact", head: true })
    .eq("status", "running");

  const { count: recentLogs } = await supabase
    .from("improvement_logs")
    .select("*", { count: "exact", head: true })
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const improvementScore = Math.min(100, (activeTests || 0) * 20 + (recentLogs || 0) * 10);
  areas["active_improvement"] = improvementScore;
  if (improvementScore < 30) recommendations.push("Start A/B tests to improve system performance");

  // Overall score
  const score = Math.round(
    Object.values(areas).reduce((a, b) => a + b, 0) / Object.values(areas).length
  );

  return { score, areas, recommendations };
}

// Initialize improvement tables
export async function initializeImprovementSystem(): Promise<boolean> {
  // Create tables via SQL (would normally be migrations)
  const createTablesSQL = `
    -- Self-improvement A/B tests
    CREATE TABLE IF NOT EXISTS self_improvement_tests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      metric TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      results_a JSONB DEFAULT '{"successes": 0, "failures": 0, "total_value": 0}',
      results_b JSONB DEFAULT '{"successes": 0, "failures": 0, "total_value": 0}',
      winner TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    -- Improvement metrics tracking
    CREATE TABLE IF NOT EXISTS improvement_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      value FLOAT NOT NULL,
      metadata JSONB,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );

    -- Improvement logs (insights, failures, successes)
    CREATE TABLE IF NOT EXISTS improvement_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      impact TEXT DEFAULT 'low',
      action_taken TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_metrics_category_name ON improvement_metrics(category, name);
    CREATE INDEX IF NOT EXISTS idx_logs_type ON improvement_logs(type);
    CREATE INDEX IF NOT EXISTS idx_tests_status ON self_improvement_tests(status);
  `;

  const { error } = await supabase.rpc("exec_sql", { sql: createTablesSQL });

  if (error) {
    console.error("Failed to initialize improvement system:", error);
    // Tables might already exist, which is fine
    return false;
  }

  console.log("Self-improvement system initialized");
  return true;
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  async function main() {
    switch (command) {
      case "assess": {
        const result = await performSelfAssessment();
        console.log("\n=== SELF-ASSESSMENT ===\n");
        console.log(`Overall Score: ${result.score}/100\n`);
        console.log("Areas:");
        for (const [area, score] of Object.entries(result.areas)) {
          const bar = "█".repeat(Math.floor(score / 10)) + "░".repeat(10 - Math.floor(score / 10));
          console.log(`  ${area}: ${bar} ${score}`);
        }
        if (result.recommendations.length > 0) {
          console.log("\nRecommendations:");
          result.recommendations.forEach((r) => console.log(`  - ${r}`));
        }
        break;
      }

      case "test": {
        const name = args[1];
        const variantA = args[2];
        const variantB = args[3];
        if (!name || !variantA || !variantB) {
          console.log("Usage: bun run self-improve.ts test <name> <variant_a> <variant_b>");
          process.exit(1);
        }
        const id = await createABTest(name, variantA, variantB, "success_rate");
        console.log(`Created A/B test: ${id}`);
        break;
      }

      case "metric": {
        const category = args[1];
        const name = args[2];
        const value = parseFloat(args[3]);
        if (!category || !name || isNaN(value)) {
          console.log("Usage: bun run self-improve.ts metric <category> <name> <value>");
          process.exit(1);
        }
        await recordMetric(category, name, value);
        console.log(`Recorded metric: ${category}/${name} = ${value}`);
        break;
      }

      case "baseline": {
        const category = args[1];
        const name = args[2];
        if (!category || !name) {
          console.log("Usage: bun run self-improve.ts baseline <category> <name>");
          process.exit(1);
        }
        const baseline = await getMetricBaseline(category, name);
        if (baseline) {
          console.log(`\nBaseline for ${category}/${name}:`);
          console.log(`  Average: ${baseline.avg.toFixed(2)}`);
          console.log(`  Range: ${baseline.min.toFixed(2)} - ${baseline.max.toFixed(2)}`);
          console.log(`  Trend: ${baseline.trend >= 0 ? "+" : ""}${baseline.trend.toFixed(2)}`);
        } else {
          console.log("No data found for this metric");
        }
        break;
      }

      default:
        console.log(`
Self-Improvement Module v1.0

Commands:
  assess              - Perform self-assessment
  test <name> <a> <b> - Create A/B test
  metric <cat> <name> <value> - Record metric
  baseline <cat> <name>       - Get metric baseline
        `);
    }
  }

  main().catch(console.error);
}
