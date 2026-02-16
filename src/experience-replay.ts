/**
 * Experience Replay Module
 *
 * Learn from past interactions by periodically re-analyzing
 * successful and failed conversations to extract patterns.
 *
 * Based on:
 * - Experience Replay in Reinforcement Learning
 * - Episodic Memory for LLM Agents
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export interface Experience {
  id: string;
  type: "success" | "failure" | "neutral";
  category: "memory" | "reasoning" | "execution" | "communication" | "scheduling";
  context: string;
  action: string;
  outcome: string;
  lessons: string[];
  replay_count: number;
  last_replay: string;
  created_at: string;
}

export interface ReplayResult {
  experiences_replayed: number;
  new_patterns_found: number;
  strategies_updated: number;
  insights: string[];
}

/**
 * Record an experience for future replay
 */
export async function recordExperience(
  type: Experience["type"],
  category: Experience["category"],
  context: string,
  action: string,
  outcome: string
): Promise<string | null> {
  // Extract lessons from the outcome
  const lessons = extractLessonsFromOutcome(type, outcome);

  const { data, error } = await supabase
    .from("experience_replay")
    .insert({
      type,
      category,
      context,
      action,
      outcome,
      lessons,
      replay_count: 0,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Replay] Failed to record experience:", error);
    return null;
  }

  return data.id;
}

/**
 * Extract lessons from outcome
 */
function extractLessonsFromOutcome(type: string, outcome: string): string[] {
  const lessons: string[] = [];

  if (type === "success") {
    if (outcome.includes("completed") || outcome.includes("success")) {
      lessons.push("Approach was effective - repeat for similar contexts");
    }
    if (outcome.includes("fast") || outcome.includes("quickly")) {
      lessons.push("Efficient execution - note optimization pattern");
    }
  } else if (type === "failure") {
    if (outcome.includes("timeout") || outcome.includes("slow")) {
      lessons.push("Consider chunking or async approach for large operations");
    }
    if (outcome.includes("not found") || outcome.includes("missing")) {
      lessons.push("Add existence check before operations");
    }
    if (outcome.includes("error") || outcome.includes("failed")) {
      lessons.push("Add error handling and fallback strategies");
    }
  }

  return lessons;
}

/**
 * Replay experiences to extract new patterns
 */
export async function replayExperiences(
  category?: Experience["category"],
  limit: number = 50
): Promise<ReplayResult> {
  let query = supabase
    .from("experience_replay")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (category) {
    query = query.eq("category", category);
  }

  const { data: experiences, error } = await query;

  if (error || !experiences) {
    console.error("[Replay] Failed to fetch experiences:", error);
    return { experiences_replayed: 0, new_patterns_found: 0, strategies_updated: 0, insights: [] };
  }

  const insights: string[] = [];
  let newPatterns = 0;
  let strategiesUpdated = 0;

  // Analyze patterns across experiences
  const categoryCounts: Record<string, { success: number; failure: number }> = {};
  const actionOutcomes: Record<string, { success: number; failure: number }> = {};

  for (const exp of experiences) {
    // Update category counts
    if (!categoryCounts[exp.category]) {
      categoryCounts[exp.category] = { success: 0, failure: 0 };
    }
    categoryCounts[exp.category][exp.type]++;

    // Track action outcomes
    const actionKey = exp.action.substring(0, 30);
    if (!actionOutcomes[actionKey]) {
      actionOutcomes[actionKey] = { success: 0, failure: 0 };
    }
    actionOutcomes[actionKey][exp.type]++;

    // Update replay count
    await supabase
      .from("experience_replay")
      .update({ replay_count: exp.replay_count + 1, last_replay: new Date().toISOString() })
      .eq("id", exp.id);
  }

  // Generate insights from patterns
  for (const [cat, counts] of Object.entries(categoryCounts)) {
    const total = counts.success + counts.failure;
    const successRate = counts.success / total;
    if (successRate < 0.5 && total >= 5) {
      insights.push(`Category "${cat}" has low success rate (${(successRate * 100).toFixed(0)}%) - needs improvement`);
      newPatterns++;
    }
  }

  for (const [action, counts] of Object.entries(actionOutcomes)) {
    const total = counts.success + counts.failure;
    if (counts.failure > counts.success && total >= 3) {
      insights.push(`Action "${action}..." fails more than succeeds - consider alternative approach`);
      strategiesUpdated++;
    }
  }

  console.log(`[Replay] Analyzed ${experiences.length} experiences, found ${newPatterns} patterns`);

  return {
    experiences_replayed: experiences.length,
    new_patterns_found: newPatterns,
    strategies_updated: strategiesUpdated,
    insights,
  };
}

/**
 * Get similar past experiences for context
 */
export async function getSimilarExperiences(
  contextQuery: string,
  limit: number = 5
): Promise<Experience[]> {
  const { data, error } = await supabase
    .from("experience_replay")
    .select("*")
    .or(`context.ilike.%${contextQuery}%,action.ilike.%${contextQuery}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[Replay] Failed to fetch similar experiences:", error);
    return [];
  }

  return data || [];
}

/**
 * Get experience statistics
 */
export async function getExperienceStats(): Promise<{
  total: number;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
  avgReplayCount: number;
  topLessons: string[];
}> {
  const { data: experiences } = await supabase
    .from("experience_replay")
    .select("type, category, replay_count, lessons");

  const total = experiences?.length || 0;

  const byType: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let totalReplays = 0;
  const lessonCounts: Record<string, number> = {};

  experiences?.forEach((exp) => {
    byType[exp.type] = (byType[exp.type] || 0) + 1;
    byCategory[exp.category] = (byCategory[exp.category] || 0) + 1;
    totalReplays += exp.replay_count || 0;
    exp.lessons?.forEach((lesson: string) => {
      lessonCounts[lesson] = (lessonCounts[lesson] || 0) + 1;
    });
  });

  const topLessons = Object.entries(lessonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lesson]) => lesson);

  return {
    total,
    byType,
    byCategory,
    avgReplayCount: total > 0 ? totalReplays / total : 0,
    topLessons,
  };
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  async function main() {
    switch (command) {
      case "stats": {
        const stats = await getExperienceStats();
        console.log("\n=== EXPERIENCE REPLAY STATS ===\n");
        console.log(`Total Experiences: ${stats.total}`);
        console.log(`Avg Replay Count: ${stats.avgReplayCount.toFixed(1)}`);
        console.log("\nBy Type:", stats.byType);
        console.log("By Category:", stats.byCategory);
        console.log("\nTop Lessons:");
        stats.topLessons.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
        break;
      }

      case "replay": {
        const result = await replayExperiences();
        console.log("\n=== REPLAY RESULTS ===\n");
        console.log(`Experiences Replayed: ${result.experiences_replayed}`);
        console.log(`New Patterns Found: ${result.new_patterns_found}`);
        console.log(`Strategies Updated: ${result.strategies_updated}`);
        if (result.insights.length > 0) {
          console.log("\nInsights:");
          result.insights.forEach((i) => console.log(`  - ${i}`));
        }
        break;
      }

      case "test": {
        console.log("\n=== TESTING EXPERIENCE REPLAY ===\n");
        await recordExperience("success", "memory", "Stored user preference", "INSERT INTO memory", "Successfully stored preference");
        await recordExperience("failure", "execution", "Process timeout", "Long running operation", "Timeout after 30s");
        console.log("Recorded test experiences");
        const stats = await getExperienceStats();
        console.log("Stats:", stats);
        break;
      }

      default:
        console.log(`
Experience Replay Module

Commands:
  stats    - View experience statistics
  replay   - Run experience replay analysis
  test     - Test with sample experiences
        `);
    }
  }

  main().catch(console.error);
}
