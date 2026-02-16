/**
 * Advanced Features Module
 *
 * Focus Mode, Business Automation Mode, and Nightly Consolidation.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "bun";

const CLAUDE_PATH = process.env.CLAUDE_PATH || process.env.HOME + "/.npm-global/bin/claude" || "claude";

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// FOCUS MODE
// ============================================================

interface FocusSession {
  project_name: string;
  started_at: string;
  weight_multiplier: number;
  filtered_goal_ids: string[];
}

let currentFocusSession: FocusSession | null = null;

export async function enterFocusMode(projectName: string): Promise<string> {
  if (!supabase) return "Focus mode requires database connection";

  console.log(`[FOCUS] Entering focus mode for: ${projectName}`);

  // Find goals matching the project
  const { data: goals } = await supabase
    .from("memory")
    .select("id, content")
    .eq("type", "goal")
    .eq("status", "active")
    .ilike("content", `%${projectName}%`);

  if (!goals || goals.length === 0) {
    return `No goals found matching "${projectName}"`;
  }

  const goalIds = goals.map(g => g.id);

  // Increase weight multiplier for matching goals
  await supabase
    .from("memory")
    .update({ weight: 3.0 })
    .in("id", goalIds);

  // Decrease weight for non-matching goals
  await supabase
    .from("memory")
    .update({ weight: 0.5 })
    .eq("type", "goal")
    .eq("status", "active")
    .not("id", "in", `(${goalIds.join(",")})`);

  currentFocusSession = {
    project_name: projectName,
    started_at: new Date().toISOString(),
    weight_multiplier: 3.0,
    filtered_goal_ids: goalIds,
  };

  return `Focus mode activated for "${projectName}" (${goals.length} goals prioritized)`;
}

export async function exitFocusMode(): Promise<string> {
  if (!currentFocusSession) {
    return "No active focus session";
  }

  if (!supabase) return "Focus mode requires database connection";

  // Reset all weights to default
  await supabase
    .from("memory")
    .update({ weight: 1.0 })
    .eq("type", "goal");

  const session = currentFocusSession;
  currentFocusSession = null;

  const duration = Math.round(
    (Date.now() - new Date(session.started_at).getTime()) / 60000
  );

  return `Focus mode ended. Session duration: ${duration} minutes`;
}

export function getFocusStatus(): FocusSession | null {
  return currentFocusSession;
}

// ============================================================
// BUSINESS AUTOMATION MODE
// ============================================================

export async function identifyRevenueOpportunities(): Promise<string[]> {
  if (!supabase) return [];

  // Get strategies and goals that might have revenue potential
  const { data: items } = await supabase
    .from("memory")
    .select("content, type")
    .in("type", ["goal", "strategy", "reflection"])
    .or("content.ilike.%monetize%,content.ilike.%revenue%,content.ilike.%SaaS%,content.ilike.%subscription%,content.ilike.%sell%")
    .eq("status", "active");

  return items?.map(i => i.content) || [];
}

export async function analyzeBusinessOpportunity(description: string): Promise<{
  opportunity: string;
  estimated_roi: string;
  effort: string;
  recommendation: string;
} | null> {
  const prompt = `# BUSINESS OPPORTUNITY ANALYSIS

You are a business analyst AI. Analyze this potential opportunity:

"${description}"

Provide:
1. **Opportunity Summary**: What is the core value proposition?
2. **Estimated ROI**: What's the potential return? (High/Medium/Low with reasoning)
3. **Effort Level**: How much work to implement? (Low/Medium/High with reasoning)
4. **Recommendation**: Should we pursue this? Why or why not?

Be realistic and practical. Consider:
- Market demand
- Implementation complexity
- Time to value
- Competitive landscape

Format your response with clear sections.`;

  try {
    const proc = spawn({
      cmd: [CLAUDE_PATH, "--dangerously-skip-permissions", "-p", prompt, "--output-format", "text"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    return {
      opportunity: description,
      estimated_roi: "See analysis",
      effort: "See analysis",
      recommendation: output.trim(),
    };
  } catch {
    return null;
  }
}

export async function createRevenueGoal(
  description: string,
  estimatedValue: string
): Promise<string | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("memory")
    .insert({
      type: "goal",
      content: `[REVENUE] ${description} (Est: ${estimatedValue})`,
      priority: 2, // High priority for revenue
      status: "active",
      weight: 2.5,
      metadata: {
        category: "revenue_opportunity",
        estimated_value: estimatedValue,
      },
    })
    .select("id")
    .single();

  if (error) {
    console.error("[FEATURES] Error creating revenue goal:", error);
    return null;
  }

  return data?.id || null;
}

// ============================================================
// NIGHTLY CONSOLIDATION
// ============================================================

export async function runNightlyConsolidation(): Promise<string> {
  console.log("[CONSOLIDATION] Starting nightly consolidation pass...");

  const results: string[] = [];

  // 1. Summarize day's activity
  if (supabase) {
    const { data: todayEvents } = await supabase
      .from("memory")
      .select("content, type, created_at")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false });

    if (todayEvents && todayEvents.length > 0) {
      results.push(`- Today's events: ${todayEvents.length}`);
      
      const byType: Record<string, number> = {};
      for (const event of todayEvents) {
        byType[event.type] = (byType[event.type] || 0) + 1;
      }
      results.push(`- By type: ${JSON.stringify(byType)}`);
    }
  }

  // 2. Archive completed goals older than 7 days
  if (supabase) {
    const { data: oldCompleted } = await supabase
      .from("memory")
      .update({ status: "archived" })
      .eq("type", "completed_goal")
      .eq("status", "completed")
      .lt("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .select("id");

    if (oldCompleted) {
      results.push(`- Archived ${oldCompleted.length} completed goals`);
    }
  }

  // 3. Detect recurring themes
  if (supabase) {
    const { data: recentContent } = await supabase
      .from("memory")
      .select("content")
      .in("type", ["goal", "action", "reflection"])
      .eq("status", "active")
      .limit(50);

    if (recentContent && recentContent.length > 5) {
      // Extract common words/phrases
      const allText = recentContent.map(r => r.content.toLowerCase()).join(" ");
      const words = allText.split(/\s+/).filter(w => w.length > 4);
      
      const wordCounts: Record<string, number> = {};
      for (const word of words) {
        wordCounts[word] = (wordCounts[word] || 0) + 1;
      }

      const themes = Object.entries(wordCounts)
        .filter(([_, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word]) => word);

      if (themes.length > 0) {
        results.push(`- Recurring themes: ${themes.join(", ")}`);
        
        // Store as reflection
        await supabase.from("memory").insert({
          type: "reflection",
          content: `Daily consolidation: Recurring themes detected - ${themes.join(", ")}`,
          status: "active",
        });
      }
    }
  }

  // 4. Check for blocked items needing attention
  if (supabase) {
    const { data: blocked } = await supabase
      .from("memory")
      .select("id, content")
      .eq("status", "blocked")
      .limit(10);

    if (blocked && blocked.length > 0) {
      results.push(`- Blocked items: ${blocked.length} need attention`);
    }
  }

  const summary = results.length > 0
    ? `Nightly Consolidation Complete:\n${results.join("\n")}`
    : "Nightly Consolidation: No significant activity";

  console.log("[CONSOLIDATION]", summary);
  return summary;
}

// ============================================================
// SYSTEM SELF-IMPROVEMENT
// ============================================================

export async function analyzeSystemBottlenecks(): Promise<string> {
  const prompt = `# SYSTEM SELF-IMPROVEMENT ANALYSIS

You are an AI system reviewing its own architecture. Analyze for:

1. **Bottlenecks**: What operations are slow or inefficient?
2. **Inefficiencies**: What code or processes could be streamlined?
3. **Structural Weaknesses**: What architectural issues need addressing?
4. **Optimization Opportunities**: What would have the highest impact improvements?

Review the following system components:
- Agent loop (3-minute cycle)
- Deep think engine (strategic planning)
- Goal decomposition
- Memory management (weighted recall)
- Sub-agent spawning

Provide specific, actionable recommendations with priority levels.

Output format:
[STRATEGY: structural improvement direction]
[ACTION: specific code/process change | PRIORITY: 1-5]`;

  try {
    const proc = spawn({
      cmd: [CLAUDE_PATH, "--dangerously-skip-permissions", "-p", prompt, "--output-format", "text"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Store the analysis
    if (supabase) {
      await supabase.from("memory").insert({
        type: "reflection",
        content: `System self-improvement analysis: ${output.substring(0, 200)}...`,
        status: "active",
        metadata: { full_analysis: output },
      });
    }

    return output.trim();
  } catch (error) {
    return `Analysis failed: ${error}`;
  }
}

// ============================================================
// EXPORTS
// ============================================================

export const features = {
  focus: {
    enter: enterFocusMode,
    exit: exitFocusMode,
    status: getFocusStatus,
  },
  business: {
    identifyOpportunities: identifyRevenueOpportunities,
    analyzeOpportunity: analyzeBusinessOpportunity,
    createRevenueGoal,
  },
  consolidation: {
    runNightly: runNightlyConsolidation,
  },
  improvement: {
    analyzeBottlenecks: analyzeSystemBottlenecks,
  },
};
