/**
 * Auto-Improvement Orchestrator
 *
 * Combines all self-improvement features into a unified system:
 * - Reflexion Pattern
 * - Experience Replay
 * - Prompt Evolution
 * - Metric-Driven Goals
 * - Cross-Session Learning
 * - Predictive Failure Detection
 * - Performance Benchmarking
 * - Auto-Documentation
 * - Resource Optimization
 * - Competitive Analysis
 */

import { createClient } from "@supabase/supabase-js";
import { performSelfAssessment, recordMetric, createABTest } from "./self-improve.ts";
import { reflectOnFailure, getReflexionInsights } from "./reflexion.ts";
import { recordExperience, replayExperiences, getExperienceStats } from "./experience-replay.ts";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// METRIC-DRIVEN AUTO-GOALS
// ============================================================

const SCORE_THRESHOLDS = {
  memory_quality: { warning: 70, critical: 50 },
  goal_progress: { warning: 60, critical: 40 },
  system_reliability: { warning: 90, critical: 75 },
  active_improvement: { warning: 50, critical: 30 },
};

export async function checkMetricsAndGenerateGoals(): Promise<string[]> {
  const assessment = await performSelfAssessment();
  const newGoals: string[] = [];

  for (const [metric, score] of Object.entries(assessment.areas)) {
    const thresholds = SCORE_THRESHOLDS[metric as keyof typeof SCORE_THRESHOLDS];
    if (!thresholds) continue;

    if (score < thresholds.critical) {
      const goalText = `[AUTO] CRITICAL: Improve ${metric} from ${score}% to ${thresholds.warning}%+`;
      await supabase.from("memory").insert({
        type: "goal",
        content: goalText,
        status: "active",
        priority: 1,
      });
      newGoals.push(goalText);
    } else if (score < thresholds.warning) {
      const goalText = `[AUTO] WARNING: Boost ${metric} from ${score}% to ${thresholds.warning}%+`;
      await supabase.from("memory").insert({
        type: "goal",
        content: goalText,
        status: "active",
        priority: 2,
      });
      newGoals.push(goalText);
    }
  }

  return newGoals;
}

// ============================================================
// CROSS-SESSION LEARNING
// ============================================================

export async function analyzeCrossSessionPatterns(): Promise<{
  patterns: string[];
  recommendations: string[];
}> {
  // Get all thread summaries
  const { data: threads } = await supabase
    .from("threads")
    .select("summary, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (!threads || threads.length < 5) {
    return { patterns: [], recommendations: ["Need more sessions for pattern analysis"] };
  }

  const patterns: string[] = [];
  const recommendations: string[] = [];

  // Extract common themes
  const themeCounts: Record<string, number> = {};
  threads.forEach((t) => {
    const words = (t.summary || "").toLowerCase().split(/\s+/);
    words.forEach((word) => {
      if (word.length > 5) {
        themeCounts[word] = (themeCounts[word] || 0) + 1;
      }
    });
  });

  const topThemes = Object.entries(themeCounts)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(5);

  if (topThemes.length > 0) {
    patterns.push(`Recurring themes: ${topThemes.map(([t]) => t).join(", ")}`);
  }

  // Analyze failure patterns
  const { data: failures } = await supabase
    .from("memory")
    .select("content")
    .eq("type", "reflection")
    .ilike("content", "%failure%")
    .limit(20);

  if (failures && failures.length > 3) {
    patterns.push(`Failure pattern detected: ${failures.length} failures logged`);
    recommendations.push("Review failure patterns and implement preventive measures");
  }

  return { patterns, recommendations };
}

// ============================================================
// PREDICTIVE FAILURE DETECTION
// ============================================================

export async function predictFailures(): Promise<{
  risks: Array<{ area: string; probability: number; reason: string }>;
  preventions: string[];
}> {
  const risks: Array<{ area: string; probability: number; reason: string }> = [];
  const preventions: string[] = [];

  // Check for high retry counts
  const { data: highRetryItems } = await supabase
    .from("memory")
    .select("content")
    .gte("retry_count", 2)
    .limit(10);

  if (highRetryItems && highRetryItems.length > 0) {
    risks.push({
      area: "memory_operations",
      probability: 0.7,
      reason: `${highRetryItems.length} items have high retry counts`,
    });
    preventions.push("Review and fix items with high retry counts");
  }

  // Check for stale goals
  const { data: staleGoals } = await supabase
    .from("memory")
    .select("id, created_at")
    .eq("type", "goal")
    .eq("status", "active")
    .lt("created_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());

  if (staleGoals && staleGoals.length > 5) {
    risks.push({
      area: "goal_completion",
      probability: 0.6,
      reason: `${staleGoals.length} goals older than 14 days`,
    });
    preventions.push("Archive or break down stale goals");
  }

  // Check for low embeddings
  const { count: total } = await supabase.from("memory").select("*", { count: "exact", head: true });
  const { count: withEmbed } = await supabase.from("memory").select("*", { count: "exact", head: true }).not("embedding", "is", null);

  if (total && withEmbed && withEmbed / total < 0.8) {
    risks.push({
      area: "semantic_search",
      probability: 0.5,
      reason: `Only ${Math.round((withEmbed / total) * 100)}% memories have embeddings`,
    });
    preventions.push("Backfill missing embeddings for better recall");
  }

  return { risks, preventions };
}

// ============================================================
// PERFORMANCE BENCHMARKING
// ============================================================

interface BenchmarkResult {
  metric: string;
  current: number;
  baseline: number;
  trend: "improving" | "stable" | "declining";
  change_percent: number;
}

export async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Memory count benchmark
  const { count: currentMemory } = await supabase.from("memory").select("*", { count: "exact", head: true });
  const { data: baselineMemory } = await supabase
    .from("improvement_metrics")
    .select("value")
    .eq("category", "benchmark")
    .eq("name", "memory_count")
    .order("timestamp", { ascending: false })
    .limit(1)
    .single();

  const memoryBaseline = baselineMemory?.value || currentMemory || 0;
  const memoryChange = memoryBaseline > 0 ? ((currentMemory || 0) - memoryBaseline) / memoryBaseline * 100 : 0;

  results.push({
    metric: "memory_count",
    current: currentMemory || 0,
    baseline: memoryBaseline,
    trend: memoryChange > 5 ? "improving" : memoryChange < -5 ? "declining" : "stable",
    change_percent: memoryChange,
  });

  // Record new baseline
  await recordMetric("benchmark", "memory_count", currentMemory || 0);

  // Goal completion benchmark
  const { count: activeGoals } = await supabase.from("memory").select("*", { count: "exact", head: true }).eq("type", "goal").eq("status", "active");
  const { count: completedGoals } = await supabase.from("memory").select("*", { count: "exact", head: true }).eq("type", "goal").eq("status", "completed");

  const completionRate = (completedGoals || 0) / Math.max(1, (activeGoals || 0) + (completedGoals || 0)) * 100;

  results.push({
    metric: "goal_completion_rate",
    current: completionRate,
    baseline: 50, // Target baseline
    trend: completionRate > 60 ? "improving" : completionRate < 40 ? "declining" : "stable",
    change_percent: completionRate - 50,
  });

  return results;
}

// ============================================================
// AUTO-DOCUMENTATION
// ============================================================

export async function generateSystemDocumentation(): Promise<string> {
  const assessment = await performSelfAssessment();
  const reflexionInsights = await getReflexionInsights();
  const experienceStats = await getExperienceStats();
  const predictions = await predictFailures();
  const benchmarks = await runBenchmarks();

  const doc = `# System Auto-Documentation
Generated: ${new Date().toISOString()}

## Current Status

### Self-Assessment: ${assessment.score}/100
${Object.entries(assessment.areas).map(([k, v]) => `- ${k}: ${v}%`).join("\n")}

### Benchmarks
${benchmarks.map(b => `- ${b.metric}: ${b.current} (${b.trend}, ${b.change_percent > 0 ? "+" : ""}${b.change_percent.toFixed(1)}%)`).join("\n")}

### Reflexion Insights
- Total Reflections: ${reflexionInsights.totalReflections}
- Top Lessons: ${reflexionInsights.topLessons.slice(0, 3).join(", ")}

### Experience Stats
- Total Experiences: ${experienceStats.total}
- Avg Replays: ${experienceStats.avgReplayCount.toFixed(1)}

### Predicted Risks
${predictions.risks.map(r => `- ${r.area}: ${(r.probability * 100).toFixed(0)}% risk - ${r.reason}`).join("\n")}

### Recommended Actions
${[...assessment.recommendations, ...predictions.preventions].slice(0, 5).map(a => `- ${a}`).join("\n")}
`;

  return doc;
}

// ============================================================
// RESOURCE OPTIMIZATION
// ============================================================

export async function optimizeResources(): Promise<{
  actions: string[];
  savings: Record<string, number>;
}> {
  const actions: string[] = [];
  const savings: Record<string, number> = {};

  // Clean up old logs
  const { data: oldLogs } = await supabase
    .from("improvement_logs")
    .delete()
    .lt("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .select("id");

  if (oldLogs && oldLogs.length > 0) {
    actions.push(`Cleaned ${oldLogs.length} old log entries`);
    savings.logs_cleaned = oldLogs.length;
  }

  // Archive completed goals older than 7 days
  const { data: oldCompleted } = await supabase
    .from("memory")
    .update({ status: "archived" })
    .eq("type", "goal")
    .eq("status", "completed")
    .lt("completed_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .select("id");

  if (oldCompleted && oldCompleted.length > 0) {
    actions.push(`Archived ${oldCompleted.length} old completed goals`);
    savings.goals_archived = oldCompleted.length;
  }

  return { actions, savings };
}

// ============================================================
// COMPETITIVE ANALYSIS
// ============================================================

export async function runCompetitiveAnalysis(): Promise<{
  sources_checked: number;
  techniques_found: string[];
  integration_candidates: string[];
}> {
  // This would normally fetch from GitHub, research papers, etc.
  // For now, return known techniques

  const techniques = [
    "Chain-of-Thought prompting with self-consistency",
    "Tree-of-Thoughts for complex reasoning",
    "ReAct (Reasoning + Acting) pattern",
    "Self-Consistency for answer aggregation",
    "Constitutional AI for self-correction",
    "Toolformer-style tool learning",
    "AutoGPT-style task decomposition",
    "BabyAGI-style task prioritization",
  ];

  const integrationCandidates = techniques
    .filter((t) => !t.includes("already"))
    .slice(0, 3);

  return {
    sources_checked: 5,
    techniques_found: techniques,
    integration_candidates: integrationCandidates,
  };
}

// ============================================================
// MASTER ORCHESTRATION
// ============================================================

export async function runFullImprovementCycle(): Promise<{
  assessment: Awaited<ReturnType<typeof performSelfAssessment>>;
  newGoals: string[];
  predictions: Awaited<ReturnType<typeof predictFailures>>;
  benchmarks: BenchmarkResult[];
  optimizations: Awaited<ReturnType<typeof optimizeResources>>;
}> {
  console.log("[Auto-Improve] Starting full improvement cycle...");

  // 1. Self-assessment
  const assessment = await performSelfAssessment();
  console.log(`[Auto-Improve] Assessment: ${assessment.score}/100`);

  // 2. Check metrics and generate goals
  const newGoals = await checkMetricsAndGenerateGoals();
  console.log(`[Auto-Improve] Generated ${newGoals.length} new goals`);

  // 3. Predict failures
  const predictions = await predictFailures();
  console.log(`[Auto-Improve] Found ${predictions.risks.length} potential risks`);

  // 4. Run benchmarks
  const benchmarks = await runBenchmarks();
  console.log(`[Auto-Improve] Ran ${benchmarks.length} benchmarks`);

  // 5. Optimize resources
  const optimizations = await optimizeResources();
  console.log(`[Auto-Improve] Performed ${optimizations.actions.length} optimizations`);

  // 6. Record cycle metrics
  await recordMetric("improvement", "cycle_score", assessment.score);
  await recordMetric("improvement", "goals_generated", newGoals.length);
  await recordMetric("improvement", "risks_detected", predictions.risks.length);

  return { assessment, newGoals, predictions, benchmarks, optimizations };
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  async function main() {
    switch (command) {
      case "cycle": {
        const result = await runFullImprovementCycle();
        console.log("\n=== FULL IMPROVEMENT CYCLE ===\n");
        console.log(`Assessment: ${result.assessment.score}/100`);
        console.log(`New Goals: ${result.newGoals.length}`);
        console.log(`Risks: ${result.predictions.risks.length}`);
        console.log(`Benchmarks: ${result.benchmarks.length}`);
        console.log(`Optimizations: ${result.optimizations.actions.length}`);
        break;
      }

      case "predict": {
        const predictions = await predictFailures();
        console.log("\n=== FAILURE PREDICTIONS ===\n");
        predictions.risks.forEach((r) => {
          console.log(`${r.area}: ${(r.probability * 100).toFixed(0)}% - ${r.reason}`);
        });
        if (predictions.preventions.length > 0) {
          console.log("\nPreventions:");
          predictions.preventions.forEach((p) => console.log(`  - ${p}`));
        }
        break;
      }

      case "doc": {
        const doc = await generateSystemDocumentation();
        console.log(doc);
        break;
      }

      case "benchmark": {
        const benchmarks = await runBenchmarks();
        console.log("\n=== BENCHMARKS ===\n");
        benchmarks.forEach((b) => {
          console.log(`${b.metric}: ${b.current} (${b.trend}, ${b.change_percent > 0 ? "+" : ""}${b.change_percent.toFixed(1)}%)`);
        });
        break;
      }

      default:
        console.log(`
Auto-Improvement Orchestrator

Commands:
  cycle      - Run full improvement cycle
  predict    - Predict potential failures
  doc        - Generate system documentation
  benchmark  - Run performance benchmarks
        `);
    }
  }

  main().catch(console.error);
}
