/**
 * Autonomous Agent Loop
 *
 * The brain that runs continuously, thinking and acting independently.
 * Not just reactive - this is proactive cognitive infrastructure.
 *
 * Responsibilities:
 * - Fetch active goals and evaluate progress
 * - Execute pending actions
 * - Create new tasks from goal decomposition
 * - Reflect on outcomes
 * - Optimize memory and strategies
 * - Self-heal when things break
 *
 * Run: bun run src/agent-loop.ts
 * Or as systemd service: claude-agent-loop.service
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { processMemoryIntents } from "./memory.ts";
import { execSync } from "child_process";
import { circuitBreakers, CircuitOpenError } from "./utils/circuit-breaker.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CHILD PROCESS TRACKING (for graceful shutdown)
// ============================================================
const activeProcesses = new Set<Bun.Subprocess>();

function killActiveChildren() {
  if (activeProcesses.size === 0) return;
  console.log(`[AGENT] Killing ${activeProcesses.size} active child process(es)...`);
  for (const proc of activeProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
  }
  activeProcesses.clear();
}

/**
 * Kill orphaned claude processes from previous agent-loop instances.
 * When PM2 restarts agent-loop, the old process may die before its
 * child claude processes, leaving them orphaned (reparented to PID 1).
 */
function killOrphanedClaudeProcesses() {
  try {
    // Find claude processes that are orphaned (ppid = 1) or whose parent is dead
    const result = Bun.spawnSync(["bash", "-c",
      `ps -eo pid,ppid,command | grep 'claude' | grep -v 'agent-loop' | grep -v grep`
    ]);
    const output = new TextDecoder().decode(result.stdout).trim();
    if (!output) return 0;

    const currentPid = process.pid;
    let killed = 0;

    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (match) {
        const pid = parseInt(match[1]);
        const ppid = parseInt(match[2]);
        const cmd = match[3];

        // Skip our own processes
        if (pid === currentPid) continue;

        // Kill if orphaned (ppid=1) or if it's a claude CLI process not from us
        if (ppid === 1 || cmd.includes('/.npm-global/bin/claude') || cmd.includes('/.bun/bin/claude')) {
          try {
            process.kill(pid, "SIGTERM");
            console.log(`[AGENT] Killed orphaned claude process ${pid}: ${cmd.substring(0, 60)}`);
            killed++;
          } catch {
            // Process already exited
          }
        }
      }
    }

    if (killed > 0) {
      console.log(`[AGENT] Cleaned up ${killed} orphaned claude process(es) on startup`);
    }
    return killed;
  } catch {
    // Best-effort cleanup
    return 0;
  }
}

// ============================================================
// CIRCUIT BREAKER for Claude API calls
// ============================================================

// Circuit breaker for agent-loop's Claude API calls
// Prevents cascading failures when API is slow or failing
const claudeCircuitBreaker = circuitBreakers.get("agent-loop-claude-api", {
  failureThreshold: 3,     // Open after 3 consecutive failures
  resetTimeout: 60000,     // Try again after 1 minute
  successThreshold: 1,     // One success closes the circuit
  onOpen: (name, failures) => {
    console.log(`[CircuitBreaker:${name}] OPENED after ${failures} failures - blocking calls for 60s`);
  },
  onClose: (name) => {
    console.log(`[CircuitBreaker:${name}] CLOSED - resuming normal operation`);
  },
});

// ============================================================
// CONFIGURATION
// ============================================================

// Resolve Claude CLI path - check multiple locations
function resolveClaudePath(): string {
  const fs = require("fs");

  // 1. Explicit env var takes priority
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  // 2. Check common locations in order (file exists, not just executable)
  const home = process.env.HOME || "/home/radxa";
  const candidates = [
    `${home}/.npm-global/bin/claude`,
    `${home}/.bun/bin/claude`,
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        console.log(`[Agent] Found Claude at: ${candidate}`);
        return candidate;
      }
    } catch {
      continue;
    }
  }

  // 3. Fall back to PATH lookup
  console.log("[Agent] Using 'claude' from PATH");
  return "claude";
}

const CLAUDE_PATH = resolveClaudePath();
const LOOP_INTERVAL_MS = parseInt(process.env.AGENT_LOOP_INTERVAL || "180000"); // 3 minutes default
const ALERT_INTERVAL_MS = parseInt(process.env.AGENT_ALERT_INTERVAL || "1800000"); // 30 minutes default
const STATE_FILE = join(process.env.HOME || "~", ".claude-relay", "agent-state.json");
const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");

// Supabase
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// Telegram notification (optional)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
let lastAlertTime = 0; // Rate limit alerts

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface AgentState {
  lastRun: string;
  runCount: number;
  lastReflection: string;
  idleCycles: number;
  lastGoalCount: number;
  lastActionCount: number;
  errors: string[];
  pendingNotifications: string[];
}

async function loadState(): Promise<AgentState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastRun: new Date().toISOString(),
      runCount: 0,
      lastReflection: "",
      idleCycles: 0,
      lastGoalCount: 0,
      lastActionCount: 0,
      errors: [],
      pendingNotifications: [],
    };
  }
}

async function saveState(state: AgentState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CLAUDE EXECUTION WITH SELF-HEALING
// ============================================================

interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  attempts: number;
}

/**
 * Check available memory before spawning Claude.
 * Returns available memory in MB, or -1 if check fails.
 */
function getAvailableMemoryMB(): number {
  try {
    const output = execSync("cat /proc/meminfo | grep MemAvailable", { encoding: "utf-8" });
    const match = output.match(/(\d+)/);
    return match ? Math.floor(parseInt(match[1]) / 1024) : -1; // Convert KB to MB
  } catch {
    return -1;
  }
}

/**
 * Check if we're under memory pressure.
 * Returns true if available memory is below threshold (default 500MB).
 */
function isUnderMemoryPressure(thresholdMB: number = 500): boolean {
  const availableMB = getAvailableMemoryMB();
  if (availableMB === -1) return false; // If we can't check, proceed
  return availableMB < thresholdMB;
}

async function callClaudeWithRetry(
  prompt: string,
  maxRetries: number = 3
): Promise<ExecutionResult> {
  // Check circuit breaker first - prevents cascading failures
  if (claudeCircuitBreaker.isOpen()) {
    console.log("[AGENT] Circuit breaker OPEN - skipping Claude call to prevent cascade");
    return {
      success: false,
      output: "",
      error: "Circuit breaker open - too many recent failures. Waiting for reset.",
      attempts: 0
    };
  }

  let lastError = "";
  const TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT || "600000"); // 10 minute default
  const MIN_MEMORY_MB = 500; // Don't spawn if less than this available

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Memory pressure guard - don't spawn if system is low on memory
    const availableMB = getAvailableMemoryMB();
    if (availableMB !== -1 && availableMB < MIN_MEMORY_MB) {
      console.log(`[AGENT] Memory pressure detected: ${availableMB}MB available (threshold: ${MIN_MEMORY_MB}MB). Skipping cycle.`);
      return { success: false, output: "", error: `Memory pressure: only ${availableMB}MB available. Skipping to prevent OOM.`, attempts: attempt };
    }

    console.log(`[Attempt ${attempt}/${maxRetries}] Calling Claude...`);

    try {
      const proc = spawn({
        cmd: [CLAUDE_PATH, "--dangerously-skip-permissions", "-p", prompt, "--output-format", "text"],
        stdout: "pipe",
        stderr: "pipe",
        timeout: TIMEOUT_MS,
      });

      // Track child process for graceful shutdown
      activeProcesses.add(proc);

      const output = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      // Remove from tracking after completion
      activeProcesses.delete(proc);

      if (exitCode === 0) {
        console.log(`[AGENT] Claude responded successfully (${output.length} chars)`);
        claudeCircuitBreaker.recordSuccess(); // Close circuit on success
        return { success: true, output: output.trim(), attempts: attempt };
      }

      lastError = stderr || `Exit code ${exitCode}`;
      console.log(`[AGENT] Claude exited with code ${exitCode}: ${lastError.substring(0, 100)}`);

      // Detect OOM kill (137 = SIGKILL, 139 = SIGSEGV) - do NOT retry these
      // Retrying OOM kills just spawns more processes that also get killed
      if (exitCode === 137 || exitCode === 139 || exitCode === 143) {
        console.log(`[AGENT] OOM/Signal kill detected (exit ${exitCode}), aborting retries to prevent cascade`);
        claudeCircuitBreaker.recordFailure(); // Record failure for circuit breaker
        return { success: false, output: "", error: `Process killed by signal (exit ${exitCode}) - likely OOM. Aborting to prevent retry loop.`, attempts: attempt };
      }

      // If not last attempt, ask Claude to fix and retry
      if (attempt < maxRetries) {
        console.log(`[Self-healing] Error detected, asking Claude to fix...`);
        prompt = `Previous command failed with error:\n${lastError}\n\nOriginal task:\n${prompt}\n\nFix the failure and retry. Analyze what went wrong and correct your approach.`;
      }
    } catch (error) {
      lastError = String(error);
      console.error(`[Attempt ${attempt}] Spawn error:`, error);
    }

    // Wait before retry with exponential backoff (2s → 4s → 8s)
    if (attempt < maxRetries) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 8000); // Cap at 8s
      console.log(`[AGENT] Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // All retries exhausted - record failure for circuit breaker
  claudeCircuitBreaker.recordFailure();
  return { success: false, output: "", error: lastError, attempts: maxRetries };
}

// ============================================================
// DATA FETCHING
// ============================================================

interface GoalData {
  id: string;
  content: string;
  deadline?: string;
  priority: number;
  status: string;
  parent_id?: string;
  child_count: number;
}

interface ActionData {
  id: string;
  content: string;
  priority: number;
  status: string;
  parent_id?: string;
}

interface AgentSystemState {
  active_goals: number;
  pending_actions: number;
  blocked_items: number;
  recent_errors: number;
  last_reflection?: string;
}

async function fetchAgentContext(): Promise<{
  goals: GoalData[];
  actions: ActionData[];
  strategies: { content: string }[];
  systemState: AgentSystemState | null;
  recentReflections: { content: string; created_at: string }[];
}> {
  if (!supabase) {
    return { goals: [], actions: [], strategies: [], systemState: null, recentReflections: [] };
  }

  const [goalsRes, actionsRes, strategiesRes, stateRes, reflectionsRes] = await Promise.all([
    supabase.rpc("get_active_goals_with_children"),
    supabase.rpc("get_pending_actions"),
    supabase.rpc("get_strategies"),
    supabase.rpc("get_agent_state"),
    supabase.rpc("get_reflections", { limit_count: 5 }),
  ]);

  return {
    goals: goalsRes.data || [],
    actions: actionsRes.data || [],
    strategies: strategiesRes.data || [],
    systemState: stateRes.data,
    recentReflections: reflectionsRes.data || [],
  };
}

// ============================================================
// TELEGRAM NOTIFICATION
// ============================================================

async function sendTelegramNotification(message: string): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
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
// SUB-AGENT SPAWNING
// ============================================================

type AgentType = "research" | "implementation" | "refactor" | "audit";

interface SubAgentResult {
  type: AgentType;
  output: string;
  success: boolean;
}

async function spawnSubAgent(
  type: AgentType,
  task: string,
  context: string
): Promise<SubAgentResult> {
  const prompts: Record<AgentType, string> = {
    research: `You are a RESEARCH agent. Your task: ${task}

Context (constrained):
${context.substring(0, 2000)}

Instructions:
- Search for relevant information
- Gather data from web, files, or databases
- Summarize findings clearly
- Output only research results, no actions

Research output:`,

    implementation: `You are an IMPLEMENTATION agent. Your task: ${task}

Context (constrained):
${context.substring(0, 2000)}

Instructions:
- Write code to solve the task
- Be specific and complete
- Include file paths and full code
- Output only implementation details

Implementation:`,

    refactor: `You are a REFACTOR agent. Your task: ${task}

Context (constrained):
${context.substring(0, 2000)}

Instructions:
- Analyze existing code for improvements
- Suggest specific refactorings
- Focus on: performance, readability, maintainability
- Output only refactoring recommendations

Refactor analysis:`,

    audit: `You are an AUDIT agent. Your task: ${task}

Context (constrained):
${context.substring(0, 2000)}

Instructions:
- Review for security issues
- Check for bugs and edge cases
- Validate error handling
- Output only audit findings

Audit report:`,
  };

  const result = await callClaudeWithRetry(prompts[type], 1);

  return {
    type,
    output: result.output,
    success: result.success,
  };
}

async function spawnMultipleAgents(
  task: string,
  context: string,
  types: AgentType[]
): Promise<SubAgentResult[]> {
  console.log(`[SUB-AGENT] Spawning ${types.length} agents for: ${task.substring(0, 50)}...`);

  const results = await Promise.all(
    types.map(type => spawnSubAgent(type, task, context))
  );

  console.log(`[SUB-AGENT] ${results.filter(r => r.success).length}/${results.length} agents completed`);
  return results;
}

function aggregateAgentResults(results: SubAgentResult[]): string {
  const sections: string[] = ["# SUB-AGENT AGGREGATE REPORT\n"];

  for (const result of results) {
    if (result.success) {
      sections.push(`## ${result.type.toUpperCase()} AGENT`);
      sections.push(result.output);
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ============================================================
// AUTONOMOUS THINKING
// ============================================================

function buildAutonomousPrompt(
  context: {
    goals: GoalData[];
    actions: ActionData[];
    strategies: { content: string }[];
    systemState: AgentSystemState | null;
    recentReflections: { content: string; created_at: string }[];
  },
  state: AgentState
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: process.env.USER_TIMEZONE || "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts: string[] = [
    "# AUTONOMOUS AGENT CYCLE",
    "",
    `Current time: ${timeStr}`,
    `Cycle #: ${state.runCount + 1}`,
    `Idle cycles: ${state.idleCycles}`,
    "",
    "## IDENTITY",
    "You are an autonomous technical operator running on a Linux machine.",
    "You think independently, plan strategically, decompose goals, execute tasks, verify outcomes, and act proactively.",
    "",
    "## CURRENT STATE",
  ];

  if (context.systemState) {
    parts.push(`- Active goals: ${context.systemState.active_goals}`);
    parts.push(`- Pending actions: ${context.systemState.pending_actions}`);
    parts.push(`- Blocked items: ${context.systemState.blocked_items}`);
    parts.push(`- Recent errors (24h): ${context.systemState.recent_errors}`);
  }

  if (context.goals.length > 0) {
    parts.push("", "## ACTIVE GOALS");
    context.goals.forEach(g => {
      const deadline = g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString()})` : "";
      const children = g.child_count > 0 ? ` [${g.child_count} sub-tasks]` : "";
      parts.push(`- [P${g.priority}] ${g.content}${deadline}${children}`);
    });
  }

  if (context.actions.length > 0) {
    parts.push("", "## PENDING ACTIONS");
    context.actions.slice(0, 10).forEach(a => {
      parts.push(`- [P${a.priority}] ${a.content}`);
    });
    if (context.actions.length > 10) {
      parts.push(`- ... and ${context.actions.length - 10} more`);
    }
  }

  if (context.strategies.length > 0) {
    parts.push("", "## CURRENT STRATEGIES");
    context.strategies.forEach(s => {
      parts.push(`- ${s.content}`);
    });
  }

  if (context.recentReflections.length > 0) {
    parts.push("", "## RECENT REFLECTIONS");
    context.recentReflections.slice(0, 3).forEach(r => {
      const date = new Date(r.created_at).toLocaleDateString();
      parts.push(`- [${date}] ${r.content.substring(0, 100)}...`);
    });
  }

  parts.push("", "## YOUR TASK");
  parts.push("Analyze the current state and decide what to do. You can:");
  parts.push("1. Execute pending actions using shell commands");
  parts.push("2. Decompose complex goals into sub-goals and actions");
  parts.push("3. Create strategies for long-term objectives");
  parts.push("4. Reflect on progress and lessons learned");
  parts.push("5. Optimize memory by consolidating or archiving old items");
  parts.push("6. Identify blocked items and propose solutions");
  parts.push("", "## MEMORY TAGS (use these to manage memory)");
  parts.push("- [ACTION: task description | PRIORITY: 1-5] - Create a new action");
  parts.push("- [GOAL: goal text | DEADLINE: date] - Create a new goal");
  parts.push("- [STRATEGY: strategic direction] - Record a strategy");
  parts.push("- [REFLECTION: insight or lesson] - Store a reflection");
  parts.push("- [BLOCKED: reason] - Mark something as blocked");
  parts.push("- [DONE: search text] - Mark goal/action complete");
  parts.push("- [REMEMBER: fact] - Store important info");
  parts.push("", "## RULES");
  parts.push("- Be proactive - don't wait for instructions");
  parts.push("- Execute tasks safely - verify before destructive actions");
  parts.push("- Reflect on outcomes - learn from successes and failures");
  parts.push("- Optimize continuously - improve processes and memory");
  parts.push("- If nothing urgent, focus on strategic improvements");
  parts.push("", "What will you do this cycle?");

  return parts.join("\n");
}

// ============================================================
// MAIN LOOP
// ============================================================

async function runAgentCycle(): Promise<void> {
  console.log("\n" + "=".repeat(50));
  console.log(`[AGENT] Starting cycle at ${new Date().toISOString()}`);
  console.log("=".repeat(50));

  const state = await loadState();
  state.runCount++;
  state.lastRun = new Date().toISOString();

  // Fetch context
  console.log("[AGENT] Fetching context...");
  const context = await fetchAgentContext();

  // Check for idle state
  const hasWork = context.goals.length > 0 || context.actions.length > 0;
  if (!hasWork) {
    state.idleCycles++;
  } else {
    state.idleCycles = 0;
  }

  // Build and execute prompt
  const prompt = buildAutonomousPrompt(context, state);
  console.log("[AGENT] Prompt length:", prompt.length, "chars");

  const result = await callClaudeWithRetry(prompt);

  if (result.success) {
    console.log("[AGENT] Claude response received");

    // Process any memory intents in the response
    if (supabase) {
      await processMemoryIntents(supabase, result.output);
    }

    // Check for important notifications (rate limited to every 30 min)
    const lowerOutput = result.output.toLowerCase();
    const now = Date.now();
    const timeSinceLastAlert = now - lastAlertTime;

    if (
      timeSinceLastAlert >= ALERT_INTERVAL_MS &&
      (lowerOutput.includes("urgent") ||
        lowerOutput.includes("critical") ||
        lowerOutput.includes("error") ||
        lowerOutput.includes("blocked") ||
        lowerOutput.includes("cycle") ||
        lowerOutput.includes("summary"))
    ) {
      // Send notification about important events (Telegram limit is 4096 chars)
      const maxLen = 4000;
      const notification = result.output.length > maxLen
        ? `[Agent Alert]\n\n${result.output.substring(0, maxLen)}\n\n... (truncated)`
        : `[Agent Alert]\n\n${result.output}`;
      await sendTelegramNotification(notification);
      lastAlertTime = now;
      console.log(`[AGENT] Alert sent, next alert in ${ALERT_INTERVAL_MS / 60000} minutes`);
    } else if (timeSinceLastAlert < ALERT_INTERVAL_MS) {
      console.log(`[AGENT] Alert skipped (rate limited, ${Math.round((ALERT_INTERVAL_MS - timeSinceLastAlert) / 60000)} min remaining)`);
    }

    // Log summary
    console.log("[AGENT] Output preview:", result.output.substring(0, 200) + "...");
  } else {
    console.error("[AGENT] Failed after", result.attempts, "attempts:", result.error);
    state.errors.push(`${new Date().toISOString()}: ${result.error}`);

    // Keep only last 10 errors
    if (state.errors.length > 10) {
      state.errors = state.errors.slice(-10);
    }

    // Log error to database
    if (supabase) {
      await supabase.rpc("log_system_event", {
        event_content: `Agent cycle failed: ${result.error}`,
        event_metadata: { level: "error", attempts: result.attempts },
      });
    }
  }

  // Update state counters
  state.lastGoalCount = context.goals.length;
  state.lastActionCount = context.actions.length;

  await saveState(state);
  console.log("[AGENT] Cycle complete. Idle cycles:", state.idleCycles);
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main() {
  console.log("[AGENT] Autonomous Agent Loop Starting...");
  console.log(`[AGENT] Loop interval: ${LOOP_INTERVAL_MS}ms`);
  console.log(`[AGENT] Alert interval: ${ALERT_INTERVAL_MS}ms (${ALERT_INTERVAL_MS / 60000} min)`);
  console.log(`[AGENT] Claude path: ${CLAUDE_PATH}`);

  // Clean up orphaned claude processes from previous instances
  killOrphanedClaudeProcesses();

  // Ensure state directory exists
  const { mkdir } = await import("fs/promises");
  await mkdir(RELAY_DIR, { recursive: true });

  // Wrapper with error handling
  const safeRunCycle = async () => {
    try {
      await runAgentCycle();
    } catch (error) {
      console.error("[AGENT] Cycle error (will retry):", error);
    }
  };

  // Run immediately
  await safeRunCycle();

  // Then run on interval
  setInterval(safeRunCycle, LOOP_INTERVAL_MS);

  console.log("[AGENT] Loop running. Press Ctrl+C to stop.");
}

// Handle shutdown
process.on("SIGINT", () => {
  console.log("\n[AGENT] Shutting down...");
  killActiveChildren();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[AGENT] Shutting down...");
  killActiveChildren();
  process.exit(0);
});

main().catch(console.error);
