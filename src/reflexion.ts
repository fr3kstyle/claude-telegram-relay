/**
 * Reflexion Pattern Module
 *
 * Self-correction after failures by analyzing what went wrong
 * and generating better strategies for future attempts.
 *
 * Based on research from:
 * - Reflexion: Language Agents with Verbal Reinforcement Learning (Shinn et al., 2023)
 * - CRITIC: Large Language Models Can Self-Correct with Tool-Integrating Critique
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export interface Reflection {
  id: string;
  failure_context: string;
  failure_type: "memory_op" | "api_call" | "reasoning" | "execution" | "other";
  analysis: string;
  lessons_learned: string[];
  improved_strategy: string;
  confidence: number;
  created_at: string;
  applied_count: number;
  success_rate: number;
}

export interface FailureContext {
  operation: string;
  error_message: string;
  context?: Record<string, unknown>;
  timestamp: string;
  retry_count: number;
}

/**
 * Analyze a failure and generate reflection
 */
export async function reflectOnFailure(
  context: FailureContext
): Promise<Reflection | null> {
  const { operation, error_message, retry_count } = context;

  // Determine failure type
  let failure_type: Reflection["failure_type"] = "other";
  if (operation.includes("memory") || operation.includes("REMEMBER") || operation.includes("FORGET")) {
    failure_type = "memory_op";
  } else if (operation.includes("API") || operation.includes("fetch") || operation.includes("call")) {
    failure_type = "api_call";
  } else if (operation.includes("goal") || operation.includes("plan") || operation.includes("strategy")) {
    failure_type = "reasoning";
  } else if (operation.includes("execute") || operation.includes("run") || operation.includes("process")) {
    failure_type = "execution";
  }

  // Generate analysis based on failure patterns
  const analysis = generateFailureAnalysis(context, failure_type);

  // Extract lessons learned
  const lessons_learned = extractLessons(context, failure_type);

  // Generate improved strategy
  const improved_strategy = generateImprovedStrategy(context, lessons_learned);

  // Calculate initial confidence based on retry count
  const confidence = Math.max(0.3, 1 - retry_count * 0.2);

  // Store reflection
  const { data, error } = await supabase
    .from("reflections")
    .insert({
      failure_context: `${operation}: ${error_message}`,
      failure_type,
      analysis,
      lessons_learned,
      improved_strategy,
      confidence,
      applied_count: 0,
      success_rate: 0,
    })
    .select()
    .single();

  if (error) {
    console.error("[Reflexion] Failed to store reflection:", error);
    return null;
  }

  console.log(`[Reflexion] Created reflection for ${failure_type} failure`);
  return data;
}

/**
 * Generate failure analysis
 */
function generateFailureAnalysis(
  context: FailureContext,
  type: Reflection["failure_type"]
): string {
  const analyses: Record<string, string[]> = {
    memory_op: [
      "Memory operation failed - check if item exists before operation",
      "Embedding mismatch - semantic search may not find exact matches",
      "Table constraint violation - verify type/status values are valid",
    ],
    api_call: [
      "API rate limit or timeout - implement exponential backoff",
      "Invalid request format - verify parameters match API schema",
      "Authentication failure - check API key validity",
    ],
    reasoning: [
      "Goal ambiguity - decompose into more specific subgoals",
      "Circular dependency detected - reorder task execution",
      "Resource constraint - prioritize high-impact goals",
    ],
    execution: [
      "Process timeout - increase timeout or chunk operation",
      "File/resource not found - verify paths before access",
      "Permission denied - check file/process permissions",
    ],
    other: [
      "Unknown error pattern - add to monitoring for future analysis",
      "Edge case encountered - add explicit handling",
    ],
  };

  const relevantAnalyses = analyses[type] || analyses.other;
  return relevantAnalyses[Math.floor(Math.random() * relevantAnalyses.length)];
}

/**
 * Extract lessons from failure
 */
function extractLessons(
  context: FailureContext,
  type: Reflection["failure_type"]
): string[] {
  const lessons: string[] = [];

  if (context.retry_count > 2) {
    lessons.push("High retry count indicates systemic issue - escalate to different approach");
  }

  if (type === "memory_op") {
    lessons.push("Always verify item exists before attempting modification");
    lessons.push("Use semantic search with lower threshold for fuzzy matching");
  }

  if (type === "api_call") {
    lessons.push("Implement retry with exponential backoff");
    lessons.push("Cache responses when possible to reduce API calls");
  }

  if (type === "reasoning") {
    lessons.push("Break complex goals into smaller, verifiable steps");
    lessons.push("Validate assumptions before proceeding");
  }

  return lessons;
}

/**
 * Generate improved strategy based on lessons
 */
function generateImprovedStrategy(
  context: FailureContext,
  lessons: string[]
): string {
  return lessons.join("; ");
}

/**
 * Get relevant reflections for a given operation
 */
export async function getRelevantReflections(
  operation: string,
  limit: number = 5
): Promise<Reflection[]> {
  // Determine operation type
  let type: Reflection["failure_type"] = "other";
  if (operation.includes("memory") || operation.includes("REMEMBER")) {
    type = "memory_op";
  } else if (operation.includes("API") || operation.includes("fetch")) {
    type = "api_call";
  } else if (operation.includes("goal") || operation.includes("plan")) {
    type = "reasoning";
  } else if (operation.includes("execute") || operation.includes("run")) {
    type = "execution";
  }

  const { data, error } = await supabase
    .from("reflections")
    .select("*")
    .eq("failure_type", type)
    .gte("confidence", 0.5)
    .order("success_rate", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[Reflexion] Failed to fetch reflections:", error);
    return [];
  }

  return data || [];
}

/**
 * Apply a reflection and track outcome
 */
export async function applyReflection(
  reflectionId: string,
  success: boolean
): Promise<void> {
  const { data: reflection } = await supabase
    .from("reflections")
    .select("applied_count, success_rate")
    .eq("id", reflectionId)
    .single();

  if (!reflection) return;

  const newCount = reflection.applied_count + 1;
  const newSuccessRate = success
    ? (reflection.success_rate * reflection.applied_count + 1) / newCount
    : (reflection.success_rate * reflection.applied_count) / newCount;

  // Adjust confidence based on success rate
  const newConfidence = Math.min(1, Math.max(0.1, newSuccessRate));

  await supabase
    .from("reflections")
    .update({
      applied_count: newCount,
      success_rate: newSuccessRate,
      confidence: newConfidence,
    })
    .eq("id", reflectionId);

  console.log(`[Reflexion] Applied reflection ${reflectionId}: ${success ? "success" : "failure"} (rate: ${newSuccessRate.toFixed(2)})`);
}

/**
 * Get reflexion insights for system improvement
 */
export async function getReflexionInsights(): Promise<{
  totalReflections: number;
  topLessons: string[];
  improvementTrends: Record<string, number>;
}> {
  const { data: reflections } = await supabase
    .from("reflections")
    .select("lessons_learned, failure_type, success_rate");

  const totalReflections = reflections?.length || 0;

  // Count lesson frequency
  const lessonCounts: Record<string, number> = {};
  reflections?.forEach((r) => {
    r.lessons_learned?.forEach((lesson: string) => {
      lessonCounts[lesson] = (lessonCounts[lesson] || 0) + 1;
    });
  });

  const topLessons = Object.entries(lessonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lesson]) => lesson);

  // Calculate improvement trends by type
  const typeStats: Record<string, { total: number; success: number }> = {};
  reflections?.forEach((r) => {
    if (!typeStats[r.failure_type]) {
      typeStats[r.failure_type] = { total: 0, success: 0 };
    }
    typeStats[r.failure_type].total++;
    typeStats[r.failure_type].success += r.success_rate || 0;
  });

  const improvementTrends: Record<string, number> = {};
  Object.entries(typeStats).forEach(([type, stats]) => {
    improvementTrends[type] = stats.success / stats.total;
  });

  return { totalReflections, topLessons, improvementTrends };
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  async function main() {
    switch (command) {
      case "insights": {
        const insights = await getReflexionInsights();
        console.log("\n=== REFLEXION INSIGHTS ===\n");
        console.log(`Total Reflections: ${insights.totalReflections}`);
        console.log("\nTop Lessons:");
        insights.topLessons.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
        console.log("\nImprovement Trends by Type:");
        Object.entries(insights.improvementTrends).forEach(([type, rate]) => {
          console.log(`  ${type}: ${(rate * 100).toFixed(1)}% success`);
        });
        break;
      }

      case "test": {
        console.log("\n=== TESTING REFLEXION ===\n");
        const reflection = await reflectOnFailure({
          operation: "memory:FORGET:nonexistent",
          error_message: "Could not find memory matching query",
          retry_count: 2,
          timestamp: new Date().toISOString(),
        });
        if (reflection) {
          console.log("Created reflection:", reflection.id);
          console.log("Analysis:", reflection.analysis);
          console.log("Lessons:", reflection.lessons_learned);
        }
        break;
      }

      default:
        console.log(`
Reflexion Pattern Module

Commands:
  insights    - View reflexion insights and trends
  test        - Test reflexion with sample failure
        `);
    }
  }

  main().catch(console.error);
}
