/**
 * Deep Think Engine
 *
 * High-token reasoning engine that runs during idle time.
 * Uses available token budget for strategic planning, optimization,
 * and deep analysis that wouldn't fit in normal conversation turns.
 *
 * Triggers when:
 * - Active goals > 2
 * - Idle time > 5 minutes
 * - Token budget available
 *
 * Performs:
 * 1. Strategic Planning Pass (3-5k tokens)
 * 2. System Optimization Pass (2-3k tokens)
 * 3. Memory Consolidation Pass (2k tokens)
 * 4. Risk Analysis Pass (2k tokens)
 *
 * Run: bun run src/deep-think.ts
 * Or scheduled via systemd timer
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { processMemoryIntents } from "./memory.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || process.env.HOME + "/.npm-global/bin/claude" || "claude";
const STATE_FILE = join(process.env.HOME || "~", ".claude-relay", "deep-think-state.json");
const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");

const MIN_IDLE_MINUTES = parseInt(process.env.DEEP_THINK_IDLE_MINUTES || "5");
const MIN_GOALS = parseInt(process.env.DEEP_THINK_MIN_GOALS || "2");
const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

// Supabase
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// STATE
// ============================================================

interface DeepThinkState {
  lastRun: string;
  runCount: number;
  lastStrategies: string[];
  lastOptimizations: string[];
  lastRisks: string[];
  insights: string[];
}

async function loadState(): Promise<DeepThinkState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastRun: "",
      runCount: 0,
      lastStrategies: [],
      lastOptimizations: [],
      lastRisks: [],
      insights: [],
    };
  }
}

async function saveState(state: DeepThinkState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CLAUDE EXECUTION
// ============================================================

async function callClaude(prompt: string): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const proc = spawn({
      cmd: [CLAUDE_PATH, "--dangerously-skip-permissions", "-p", prompt, "--output-format", "text"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      return { success: true, output: output.trim() };
    }

    return { success: false, output: "", error: stderr || `Exit code ${exitCode}` };
  } catch (error) {
    return { success: false, output: "", error: String(error) };
  }
}

// ============================================================
// CONTEXT FETCHING
// ============================================================

async function fetchContext(): Promise<{
  goals: any[];
  actions: any[];
  strategies: any[];
  systemState: any;
}> {
  if (!supabase) {
    return { goals: [], actions: [], strategies: [], systemState: null };
  }

  const [goalsRes, actionsRes, strategiesRes, stateRes] = await Promise.all([
    supabase.rpc("get_active_goals_with_children"),
    supabase.rpc("get_pending_actions"),
    supabase.rpc("get_strategies"),
    supabase.rpc("get_agent_state"),
  ]);

  return {
    goals: goalsRes.data || [],
    actions: actionsRes.data || [],
    strategies: strategiesRes.data || [],
    systemState: stateRes.data,
  };
}

// ============================================================
// DEEP THINK PASSES
// ============================================================

function buildContextSection(context: any): string {
  const parts: string[] = [];

  if (context.goals.length > 0) {
    parts.push("## ACTIVE GOALS");
    context.goals.forEach((g: any) => {
      const deadline = g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString()})` : "";
      parts.push(`- [P${g.priority}] ${g.content}${deadline}`);
    });
  }

  if (context.actions.length > 0) {
    parts.push("", "## PENDING ACTIONS");
    context.actions.slice(0, 15).forEach((a: any) => {
      parts.push(`- [P${a.priority}] ${a.content}`);
    });
  }

  if (context.strategies.length > 0) {
    parts.push("", "## CURRENT STRATEGIES");
    context.strategies.forEach((s: any) => {
      parts.push(`- ${s.content}`);
    });
  }

  return parts.join("\n");
}

async function strategicPlanningPass(context: any, state: DeepThinkState): Promise<string> {
  console.log("[DEEP-THINK] Running Strategic Planning Pass...");

  const prompt = `# STRATEGIC PLANNING PASS

You are an autonomous AI system analyzing its current state for strategic opportunities.

${buildContextSection(context)}

## SYSTEM STATE
- Active goals: ${context.systemState?.active_goals || 0}
- Pending actions: ${context.systemState?.pending_actions || 0}
- Blocked items: ${context.systemState?.blocked_items || 0}

## YOUR TASK
Analyze the current state deeply and propose:

1. **Strategic Improvements**: What structural changes would maximize effectiveness?
2. **Automation Opportunities**: What recurring tasks could be automated?
3. **Risk Mitigation**: What risks need proactive handling?
4. **Revenue Opportunities**: If applicable, what value-creating opportunities exist?
5. **Priority Adjustments**: Are goal priorities correctly aligned?

Think deeply. Use 3000+ tokens of reasoning. Be specific and actionable.

Output your analysis, then provide concrete recommendations in this format:
[STRATEGY: specific strategic direction]
[ACTION: specific action to take | PRIORITY: 1-5]

End with a brief summary of key insights.`;

  const result = await callClaude(prompt);
  if (result.success && supabase) {
    await processMemoryIntents(supabase, result.output);
  }
  return result.success ? result.output : `Error: ${result.error}`;
}

async function systemOptimizationPass(context: any, state: DeepThinkState): Promise<string> {
  console.log("[DEEP-THINK] Running System Optimization Pass...");

  const prompt = `# SYSTEM OPTIMIZATION PASS

You are an autonomous AI system optimizing its own operations.

${buildContextSection(context)}

## YOUR TASK
Analyze and optimize:

1. **Memory Efficiency**: Are there duplicate or stale memories to consolidate?
2. **Action Pipeline**: Are actions optimally sequenced? Any blockers?
3. **Goal Hierarchy**: Are goals properly decomposed? Missing subgoals?
4. **Process Improvements**: What workflows could be streamlined?

Focus on making the system more efficient. Propose specific optimizations.

Use 2000+ tokens of reasoning. Be concrete.

Output optimizations in this format:
[REMEMBER: important optimization insight]
[ACTION: specific optimization action | PRIORITY: 1-5]`;

  const result = await callClaude(prompt);
  if (result.success && supabase) {
    await processMemoryIntents(supabase, result.output);
  }
  return result.success ? result.output : `Error: ${result.error}`;
}

async function memoryConsolidationPass(context: any, state: DeepThinkState): Promise<string> {
  console.log("[DEEP-THINK] Running Memory Consolidation Pass...");

  const prompt = `# MEMORY CONSOLIDATION PASS

You are an autonomous AI system consolidating and organizing its memory.

${buildContextSection(context)}

## YOUR TASK
Review the current state and:

1. **Synthesize Patterns**: What patterns emerge from recent activities?
2. **Extract Insights**: What have we learned that should be remembered?
3. **Archive Completed**: Identify items ready for archival
4. **Link Related Items**: What memories should be connected?

Create consolidated memories that capture higher-level insights:
[REFLECTION: key insight or lesson learned]
[STRATEGY: emergent strategy from pattern analysis]

Use 1500+ tokens. Focus on quality over quantity.`;

  const result = await callClaude(prompt);
  if (result.success && supabase) {
    await processMemoryIntents(supabase, result.output);
  }
  return result.success ? result.output : `Error: ${result.error}`;
}

async function riskAnalysisPass(context: any, state: DeepThinkState): Promise<string> {
  console.log("[DEEP-THINK] Running Risk Analysis Pass...");

  const prompt = `# RISK ANALYSIS PASS

You are an autonomous AI system analyzing risks and potential failures.

${buildContextSection(context)}

## YOUR TASK
Analyze risks across these dimensions:

1. **Goal Risks**: Which goals are at risk of not being completed? Why?
2. **Dependency Risks**: What dependencies could cause cascade failures?
3. **Resource Risks**: Are there resource constraints (time, compute, API limits)?
4. **External Risks**: What external factors could impact plans?

For each identified risk, propose mitigation:
[BLOCKED: item that is blocked and why]
[ACTION: risk mitigation action | PRIORITY: 1-5]
[REFLECTION: risk insight]

Use 1500+ tokens. Be thorough.`;

  const result = await callClaude(prompt);
  if (result.success && supabase) {
    await processMemoryIntents(supabase, result.output);
  }
  return result.success ? result.output : `Error: ${result.error}`;
}

// ============================================================
// MAIN
// ============================================================

async function shouldRunDeepThink(context: any, state: DeepThinkState): Promise<boolean> {
  // Check if enough time has passed since last run
  if (state.lastRun) {
    const lastRun = new Date(state.lastRun);
    const minutesSince = (Date.now() - lastRun.getTime()) / (1000 * 60);
    if (minutesSince < MIN_IDLE_MINUTES) {
      console.log(`[DEEP-THINK] Too soon since last run (${minutesSince.toFixed(1)} min)`);
      return false;
    }
  }

  // Check if there's enough work to justify
  if (context.goals.length < MIN_GOALS) {
    console.log(`[DEEP-THINK] Not enough goals (${context.goals.length} < ${MIN_GOALS})`);
    return false;
  }

  return true;
}

async function runDeepThink(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log(`[DEEP-THINK] Starting at ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  const state = await loadState();
  const context = await fetchContext();

  // Check if we should run
  if (!(await shouldRunDeepThink(context, state))) {
    console.log("[DEEP-THINK] Conditions not met, skipping");
    return;
  }

  state.runCount++;
  state.lastRun = new Date().toISOString();

  // Run all passes
  const results = {
    strategic: "",
    optimization: "",
    consolidation: "",
    risk: "",
  };

  try {
    results.strategic = await strategicPlanningPass(context, state);
    state.lastStrategies = extractStrategies(results.strategic);
  } catch (e) {
    console.error("[DEEP-THINK] Strategic pass failed:", e);
  }

  try {
    results.optimization = await systemOptimizationPass(context, state);
    state.lastOptimizations = extractActions(results.optimization);
  } catch (e) {
    console.error("[DEEP-THINK] Optimization pass failed:", e);
  }

  try {
    results.consolidation = await memoryConsolidationPass(context, state);
  } catch (e) {
    console.error("[DEEP-THINK] Consolidation pass failed:", e);
  }

  try {
    results.risk = await riskAnalysisPass(context, state);
    state.lastRisks = extractRisks(results.risk);
  } catch (e) {
    console.error("[DEEP-THINK] Risk pass failed:", e);
  }

  // Update insights
  state.insights = [
    ...state.insights,
    `[${new Date().toISOString()}] Deep think cycle #${state.runCount} completed`,
  ].slice(-20); // Keep last 20

  await saveState(state);

  console.log("\n[DEEP-THINK] Cycle complete");
  console.log("[DEEP-THINK] New strategies:", state.lastStrategies.length);
  console.log("[DEEP-THINK] New optimizations:", state.lastOptimizations.length);
  console.log("[DEEP-THINK] Risks identified:", state.lastRisks.length);
}

function extractStrategies(text: string): string[] {
  const matches = text.match(/\[STRATEGY:\s*(.+?)\]/gi) || [];
  return matches.map(m => m.replace(/\[STRATEGY:\s*|\]/g, ""));
}

function extractActions(text: string): string[] {
  const matches = text.match(/\[ACTION:\s*(.+?)\]/gi) || [];
  return matches.map(m => m.replace(/\[ACTION:\s*|\]/g, ""));
}

function extractRisks(text: string): string[] {
  const matches = text.match(/\[BLOCKED:\s*(.+?)\]/gi) || [];
  return matches.map(m => m.replace(/\[BLOCKED:\s*|\]/g, ""));
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main() {
  console.log("[DEEP-THINK] High-Token Reasoning Engine");
  console.log(`[DEEP-THINK] Check interval: ${CHECK_INTERVAL_MS / 1000}s, min idle: ${MIN_IDLE_MINUTES}m, min goals: ${MIN_GOALS}`);

  // Ensure state directory exists
  const { mkdir } = await import("fs/promises");
  await mkdir(RELAY_DIR, { recursive: true });

  // Run initial check immediately
  await runDeepThink();

  // Then check periodically - idling keeps PM2 from restarting
  setInterval(async () => {
    try {
      await runDeepThink();
    } catch (error) {
      console.error("[DEEP-THINK] Error in cycle:", error);
    }
  }, CHECK_INTERVAL_MS);

  console.log("[DEEP-THINK] Idling, will check again in 60s");
}

main().catch(console.error);
