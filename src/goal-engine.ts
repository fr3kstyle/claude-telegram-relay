/**
 * Hierarchical Goal Engine
 *
 * Decomposes complex goals into sub-goals and actionable tasks.
 * Creates parent-child relationships and assigns priorities.
 *
 * Used by the agent loop when encountering complex goals that
 * need to be broken down for execution.
 *
 * Run: bun run src/goal-engine.ts [goal_id]
 */

import { spawn } from "bun";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { processMemoryIntents } from "./memory.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || process.env.HOME + "/.npm-global/bin/claude" || "claude";

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// TYPES
// ============================================================

interface Goal {
  id: string;
  content: string;
  deadline?: string;
  priority: number;
  weight: number;
  status: string;
  parent_id?: string;
  metadata?: any;
}

interface SubGoal {
  content: string;
  priority: number;
  deadline?: string;
}

interface Action {
  content: string;
  priority: number;
}

interface DecompositionResult {
  subGoals: SubGoal[];
  actions: Action[];
  analysis: string;
}

// ============================================================
// CLAUDE EXECUTION
// ============================================================

async function callClaude(prompt: string): Promise<{ success: boolean; output: string }> {
  try {
    const proc = spawn({
      cmd: [CLAUDE_PATH, "--dangerously-skip-permissions", "-p", prompt, "--output-format", "text"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    return { success: exitCode === 0, output: output.trim() };
  } catch (error) {
    return { success: false, output: String(error) };
  }
}

// ============================================================
// GOAL OPERATIONS
// ============================================================

export async function getGoal(goalId: string): Promise<Goal | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("memory")
    .select("*")
    .eq("id", goalId)
    .eq("type", "goal")
    .single();

  if (error || !data) return null;
  return data as Goal;
}

export async function getUndecomposedGoals(): Promise<Goal[]> {
  if (!supabase) return [];

  // Get goals that have no children (not yet decomposed)
  const { data } = await supabase.rpc("get_active_goals_with_children");

  if (!data) return [];

  // Filter to goals without children that seem complex enough to decompose
  return data.filter((g: any) => {
    // Skip if already has children
    if (g.child_count > 0) return false;

    // Skip if too simple (less than 5 words usually means simple task)
    const wordCount = g.content.split(/\s+/).length;
    if (wordCount < 5) return false;

    // Complex keywords that suggest decomposition needed
    const complexKeywords = [
      "build", "create", "develop", "implement", "design",
      "set up", "configure", "integrate", "migrate", "refactor",
      "launch", "deploy", "automate", "optimize", "establish",
    ];

    const hasComplexKeyword = complexKeywords.some(kw =>
      g.content.toLowerCase().includes(kw)
    );

    return hasComplexKeyword;
  });
}

export async function createSubGoal(
  parentGoalId: string,
  content: string,
  priority: number,
  deadline?: string
): Promise<string | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("memory")
    .insert({
      type: "goal",
      content,
      priority,
      parent_id: parentGoalId,
      deadline: deadline || null,
      status: "active",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[GOAL-ENGINE] Error creating sub-goal:", error);
    return null;
  }

  console.log(`[GOAL-ENGINE] Created sub-goal: ${content}`);
  return data?.id || null;
}

export async function createAction(
  parentGoalId: string,
  content: string,
  priority: number
): Promise<string | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("memory")
    .insert({
      type: "action",
      content,
      priority,
      parent_id: parentGoalId,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[GOAL-ENGINE] Error creating action:", error);
    return null;
  }

  console.log(`[GOAL-ENGINE] Created action: ${content}`);
  return data?.id || null;
}

// ============================================================
// DECOMPOSITION
// ============================================================

export async function decomposeGoal(goalId: string): Promise<DecompositionResult | null> {
  const goal = await getGoal(goalId);
  if (!goal) {
    console.error("[GOAL-ENGINE] Goal not found:", goalId);
    return null;
  }

  console.log(`[GOAL-ENGINE] Decomposing goal: ${goal.content}`);

  const prompt = `# GOAL DECOMPOSITION

You are an expert project planner. Decompose the following goal into sub-goals and concrete actions.

## GOAL
"${goal.content}"

${goal.deadline ? `## DEADLINE\n${new Date(goal.deadline).toLocaleDateString()}\n` : ""}

## CURRENT PRIORITY
${goal.priority}

## YOUR TASK
Analyze this goal deeply and break it down:

1. **First**, identify 2-5 sub-goals that represent major milestones
2. **Then**, for each sub-goal, identify 1-3 concrete actions
3. **Finally**, assign priorities (1-5, where 5 is highest)

Consider:
- Dependencies between tasks
- Resource requirements
- Risk areas
- Realistic sequencing

## OUTPUT FORMAT
Provide your analysis, then output in this exact format:

### SUB-GOALS
[GOAL: sub-goal description | DEADLINE: date (optional)]
[GOAL: another sub-goal | DEADLINE: date]

### ACTIONS
[ACTION: specific action to take | PRIORITY: 1-5]
[ACTION: another action | PRIORITY: 3]

### ANALYSIS
Brief summary of the decomposition strategy.

Use at least 2000 tokens of reasoning before outputting the structured results.`;

  const result = await callClaude(prompt);

  if (!result.success) {
    console.error("[GOAL-ENGINE] Decomposition failed");
    return null;
  }

  // Parse the response
  const subGoals: SubGoal[] = [];
  const actions: Action[] = [];

  // Extract sub-goals
  const goalMatches = result.output.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi);
  for (const match of goalMatches) {
    subGoals.push({
      content: match[1].trim(),
      priority: goal.priority, // Inherit parent priority
      deadline: match[2]?.trim(),
    });
  }

  // Extract actions
  const actionMatches = result.output.matchAll(/\[ACTION:\s*(.+?)\s*\|\s*PRIORITY:\s*(\d)\]/gi);
  for (const match of actionMatches) {
    actions.push({
      content: match[1].trim(),
      priority: parseInt(match[2]),
    });
  }

  console.log(`[GOAL-ENGINE] Extracted ${subGoals.length} sub-goals and ${actions.length} actions`);

  return {
    subGoals,
    actions,
    analysis: result.output,
  };
}

export async function executeDecomposition(goalId: string): Promise<boolean> {
  const decomposition = await decomposeGoal(goalId);
  if (!decomposition) return false;

  // Create sub-goals
  for (const sg of decomposition.subGoals) {
    await createSubGoal(goalId, sg.content, sg.priority, sg.deadline);
  }

  // Create actions (attach to parent goal)
  for (const action of decomposition.actions) {
    await createAction(goalId, action.content, action.priority);
  }

  return true;
}

// ============================================================
// GOAL STATUS MANAGEMENT
// ============================================================

export async function completeGoal(goalId: string): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase.rpc("complete_goal_cascade", { goal_id: goalId });

  if (error) {
    console.error("[GOAL-ENGINE] Error completing goal:", error);
    return false;
  }

  console.log(`[GOAL-ENGINE] Goal ${goalId} completed (with cascade)`);
  return true;
}

export async function blockGoal(goalId: string, reason: string): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase.rpc("block_goal", {
    goal_id: goalId,
    reason,
  });

  if (error) {
    console.error("[GOAL-ENGINE] Error blocking goal:", error);
    return false;
  }

  console.log(`[GOAL-ENGINE] Goal ${goalId} blocked: ${reason}`);
  return true;
}

export async function getGoalHierarchy(goalId: string): Promise<any> {
  if (!supabase) return null;

  // Get the goal and all its descendants
  const { data: goal } = await supabase
    .from("memory")
    .select("*")
    .eq("id", goalId)
    .single();

  if (!goal) return null;

  const { data: children } = await supabase
    .from("memory")
    .select("*")
    .eq("parent_id", goalId)
    .order("priority", { ascending: false });

  return {
    ...goal,
    children: children || [],
  };
}

// ============================================================
// BATCH OPERATIONS
// ============================================================

export async function decomposeAllComplexGoals(): Promise<number> {
  const goals = await getUndecomposedGoals();
  console.log(`[GOAL-ENGINE] Found ${goals.length} goals to decompose`);

  let decomposed = 0;
  for (const goal of goals) {
    const success = await executeDecomposition(goal.id);
    if (success) decomposed++;
  }

  return decomposed;
}

// ============================================================
// CLI ENTRY POINT
// ============================================================

async function main() {
  const goalId = process.argv[2];

  if (goalId) {
    // Decompose specific goal
    console.log(`[GOAL-ENGINE] Decomposing goal: ${goalId}`);
    const result = await executeDecomposition(goalId);
    console.log(`[GOAL-ENGINE] Result: ${result ? "Success" : "Failed"}`);
  } else {
    // Decompose all complex goals
    console.log("[GOAL-ENGINE] Finding goals to decompose...");
    const count = await decomposeAllComplexGoals();
    console.log(`[GOAL-ENGINE] Decomposed ${count} goals`);
  }
}

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}
