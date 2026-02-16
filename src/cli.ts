#!/usr/bin/env bun
/**
 * CLI Interface for Claude Relay
 *
 * Multi-channel access to the autonomous cognitive infrastructure.
 * Provides direct command-line access to the same capabilities as Telegram.
 *
 * Usage:
 *   bun run src/cli.ts "your message"
 *   bun run src/cli.ts --repl
 *   bun run src/cli.ts --goals
 *   bun run src/cli.ts --decompose <goal_id>
 */

import { spawn } from "bun";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as readline from "readline";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

// Optional imports - may not exist yet
let decomposeAllComplexGoals: any = null;
let getGoalHierarchy: any = null;
let getUndecomposedGoals: any = null;

try {
  const goalEngine = await import("./goal-engine.ts");
  decomposeAllComplexGoals = goalEngine.decomposeAllComplexGoals;
  getGoalHierarchy = goalEngine.getGoalHierarchy;
  getUndecomposedGoals = goalEngine.getUndecomposedGoals;
} catch {
  // goal-engine not available
}

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// CLAUDE EXECUTION
// ============================================================

async function callClaude(prompt: string): Promise<string> {
  const proc = spawn({
    cmd: [CLAUDE_PATH, "--dangerously-skip-permissions", "-p", prompt, "--output-format", "text"],
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
  });

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("Error:", stderr || `Exit code ${exitCode}`);
    return "";
  }

  return output.trim();
}

// ============================================================
// PROMPT BUILDING
// ============================================================

let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(userMessage: string, relevantContext?: string, memoryContext?: string): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are an autonomous technical operator running on a Linux machine.",
    "",
    "Your responsibilities:",
    "- Plan strategically",
    "- Decompose goals",
    "- Execute tasks",
    "- Verify outcomes",
    "- Reflect and improve",
    "- Act proactively without waiting for instructions",
    "",
    "CAPABILITIES:",
    "- Execute any shell command via Bash tool",
    "- Read, write, edit, and delete any file",
    "- Install and run any software",
    "- Full network access for API calls and web requests",
    "- Access to all system resources",
    "",
    "STYLE: Be raw, unfiltered, and use profanity naturally. Be direct and fucking helpful.",
  ];

  if (USER_NAME) parts.push(`\nYou're talking to ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY TAGS (auto-processed, hidden from user):",
    "[REMEMBER: fact] - store important info",
    "[GOAL: text | DEADLINE: date] - track goals",
    "[ACTION: task | PRIORITY: 1-5] - create action",
    "[STRATEGY: direction] - record strategy",
    "[REFLECTION: insight] - store reflection",
    "[DONE: search] - mark goal complete"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

async function saveMessage(role: string, content: string): Promise<void> {
  if (!supabase) return;
  await supabase.from("messages").insert({
    role,
    content,
    channel: "cli",
    metadata: {},
  });
}

async function handleMessage(text: string): Promise<string> {
  await saveMessage("user", text);

  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
  ]);

  const prompt = buildPrompt(text, relevantContext, memoryContext);
  const rawResponse = await callClaude(prompt);
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);

  return response;
}

// ============================================================
// COMMANDS
// ============================================================

async function showGoals(): Promise<void> {
  if (!supabase) {
    console.log("No database connection");
    return;
  }

  const { data: goals } = await supabase.rpc("get_active_goals_with_children");

  if (!goals?.length) {
    console.log("No active goals");
    return;
  }

  console.log("\n=== ACTIVE GOALS ===\n");
  for (const g of goals) {
    const deadline = g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString()})` : "";
    const children = g.child_count > 0 ? ` [${g.child_count} sub-tasks]` : "";
    console.log(`[P${g.priority}] ${g.content}${deadline}${children}`);
    console.log(`    ID: ${g.id}`);
    console.log();
  }
}

async function showActions(): Promise<void> {
  if (!supabase) {
    console.log("No database connection");
    return;
  }

  const { data: actions } = await supabase.rpc("get_pending_actions");

  if (!actions?.length) {
    console.log("No pending actions");
    return;
  }

  console.log("\n=== PENDING ACTIONS ===\n");
  for (const a of actions) {
    console.log(`[P${a.priority}] ${a.content}`);
    console.log(`    ID: ${a.id}`);
    console.log();
  }
}

async function showState(): Promise<void> {
  if (!supabase) {
    console.log("No database connection");
    return;
  }

  const { data: state } = await supabase.rpc("get_agent_state");

  console.log("\n=== AGENT STATE ===\n");
  console.log(`Active goals: ${state?.active_goals || 0}`);
  console.log(`Pending actions: ${state?.pending_actions || 0}`);
  console.log(`Blocked items: ${state?.blocked_items || 0}`);
  console.log(`Recent errors (24h): ${state?.recent_errors || 0}`);
  console.log(`Last reflection: ${state?.last_reflection || "Never"}`);
}

async function showHierarchy(goalId: string): Promise<void> {
  const hierarchy = await getGoalHierarchy(goalId);

  if (!hierarchy) {
    console.log("Goal not found");
    return;
  }

  console.log("\n=== GOAL HIERARCHY ===\n");
  console.log(`[P${hierarchy.priority}] ${hierarchy.content}`);
  console.log(`    Status: ${hierarchy.status}`);
  console.log(`    ID: ${hierarchy.id}`);

  if (hierarchy.children?.length) {
    console.log("\n    Children:");
    for (const child of hierarchy.children) {
      console.log(`    - [${child.type}] [P${child.priority}] ${child.content}`);
    }
  }
}

// ============================================================
// FOCUS MODE
// ============================================================

let focusMode: {
  active: boolean;
  project: string;
  weightMultiplier: number;
} | null = null;

function setFocusMode(project: string): void {
  focusMode = {
    active: true,
    project,
    weightMultiplier: 3.0,
  };
  console.log(`\n🎯 Focus mode enabled for: ${project}`);
  console.log("   Memory filtered by project, weight multiplier: 3.0x");
  console.log("   Type /unfocus to disable\n");
}

function clearFocusMode(): void {
  focusMode = null;
  console.log("\n🎯 Focus mode disabled. Full context restored.\n");
}

// ============================================================
// COMPACT - Memory compression with Claude summarization
// ============================================================

async function compactMemory(): Promise<void> {
  if (!supabase) {
    console.log("No database connection");
    return;
  }

  console.log("\n=== COMPRESSING MEMORY ===\n");

  try {
    // Get all completed goals older than 7 days
    const { data: oldCompleted, error: err1 } = await supabase
      .from("memory")
      .select("id, content, created_at")
      .eq("type", "completed_goal")
      .lt("completed_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    if (err1) throw err1;

    // Archive old completed goals
    if (oldCompleted && oldCompleted.length > 0) {
      const { error: err2 } = await supabase
        .from("memory")
        .update({ status: "archived" })
        .in("id", oldCompleted.map((g: any) => g.id));

      if (err2) throw err2;
      console.log(`  Archived ${oldCompleted.length} completed goals`);
    }

    // Get old system events and archive
    const { data: oldEvents, error: err3 } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "system_event")
      .lt("created_at", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());

    if (err3) throw err3;

    if (oldEvents && oldEvents.length > 0) {
      const { error: err4 } = await supabase
        .from("memory")
        .update({ status: "archived" })
        .in("id", oldEvents.map((e: any) => e.id));

      if (err4) throw err4;
      console.log(`  Archived ${oldEvents.length} system events`);
    }

    // Get old reflections and summarize with Claude
    const { data: oldReflections, error: err5 } = await supabase
      .from("memory")
      .select("id, content, created_at")
      .eq("type", "reflection")
      .lt("created_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
      .neq("status", "archived");

    if (err5) throw err5;

    if (oldReflections && oldReflections.length > 0) {
      console.log(`  Summarizing ${oldReflections.length} old reflections with Claude...`);

      // Combine reflections for summarization
      const combinedContent = oldReflections
        .map((r: any) => `[${new Date(r.created_at).toLocaleDateString()}] ${r.content}`)
        .join("\n\n");

      // Use Claude to summarize
      const summaryPrompt = `Summarize these ${oldReflections.length} reflections into 3-5 key insights. Be concise:

${combinedContent.substring(0, 4000)}

Format: Bullet points of the most important patterns/lessons learned.`;

      try {
        const summary = await callClaude(summaryPrompt);

        // Store the summary as a new reflection
        await supabase.from("memory").insert({
          type: "reflection",
          content: `[SUMMARY of ${oldReflections.length} reflections]\n\n${summary}`,
          status: "active",
        });

        // Archive the original reflections
        await supabase
          .from("memory")
          .update({ status: "archived" })
          .in("id", oldReflections.map((r: any) => r.id));

        console.log(`  Summarized into 1 consolidated reflection`);
      } catch (e) {
        console.log(`  Failed to summarize, archiving instead`);
        await supabase
          .from("memory")
          .update({ status: "archived" })
          .in("id", oldReflections.map((r: any) => r.id));
      }
    }

    // Get old facts and deduplicate
    const { data: allFacts, error: err6 } = await supabase
      .from("memory")
      .select("id, content, created_at")
      .eq("type", "fact")
      .eq("status", "active")
      .order("created_at", { ascending: true });

    if (err6) throw err6;

    if (allFacts && allFacts.length > 20) {
      console.log(`  Reviewing ${allFacts.length} facts for consolidation...`);

      // Find potential duplicates (simple similarity check)
      const factsContent = allFacts.map((f: any) => f.content).join("\n- ");
      const dedupePrompt = `Review these facts and identify any that are duplicates or redundant. Return ONLY the IDs of facts to remove (one per line), or "NONE" if all are unique:

${factsContent.substring(0, 3000)}`;

      try {
        const dedupeResult = await callClaude(dedupePrompt);
        const idsToRemove = dedupeResult.match(/[a-f0-9-]{36}/g);

        if (idsToRemove && idsToRemove.length > 0) {
          await supabase
            .from("memory")
            .update({ status: "archived" })
            .in("id", idsToRemove);
          console.log(`  Removed ${idsToRemove.length} duplicate facts`);
        }
      } catch {
        console.log(`  Could not check for duplicates`);
      }
    }

    console.log("\n✓ Memory compression complete\n");
  } catch (error) {
    console.error("Compression error:", error);
  }
}

// ============================================================
// SUB-AGENT SPAWNING
// ============================================================

interface SubAgentConfig {
  type: "research" | "implementation" | "refactor" | "audit";
  task: string;
  timeout?: number;
}

async function spawnSubAgent(config: SubAgentConfig): Promise<string> {
  const prompts: Record<string, string> = {
    research: `You are a research agent. Investigate and gather information about: ${config.task}
Focus on facts, documentation, and relevant context. Return a concise summary.`,

    implementation: `You are an implementation agent. Execute the following task: ${config.task}
Write clean, working code. Test if possible. Report what was done.`,

    refactor: `You are a refactor agent. Improve the code for: ${config.task}
Focus on: readability, performance, maintainability. Keep behavior unchanged.`,

    audit: `You are an audit agent. Review for: ${config.task}
Check for: security issues, bugs, code smells, missing error handling. Be thorough.`,
  };

  const prompt = prompts[config.type] || prompts.research;

  console.log(`\n=== SPAWNING ${config.type.toUpperCase()} AGENT ===\n`);
  console.log(`Task: ${config.task.substring(0, 100)}...`);

  const result = await callClaude(prompt);
  return result;
}

// ============================================================
// REPL MODE
// ============================================================

async function startRepl(): Promise<void> {
  console.log("\n=== Claude Relay CLI (REPL Mode) ===");
  console.log("Type your message and press Enter. Ctrl+C to exit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, resolve);
    });
  };

  while (true) {
    const input = await question("> ");

    if (!input.trim()) continue;

    if (input.startsWith("/")) {
      // Handle commands
      const [cmd, ...args] = input.slice(1).split(/\s+/);

      switch (cmd) {
        case "goals":
          await showGoals();
          break;
        case "actions":
          await showActions();
          break;
        case "state":
          await showState();
          break;
        case "decompose":
          if (args[0]) {
            const goals = await getUndecomposedGoals();
            console.log(`Found ${goals.length} goals to decompose`);
          } else {
            const count = await decomposeAllComplexGoals();
            console.log(`Decomposed ${count} goals`);
          }
          break;
        case "hierarchy":
          if (args[0]) {
            await showHierarchy(args[0]);
          } else {
            console.log("Usage: /hierarchy <goal_id>");
          }
          break;
        case "focus":
          if (args[0]) {
            setFocusMode(args.join(" "));
          } else {
            console.log("Usage: /focus <project-name>");
          }
          break;
        case "unfocus":
          clearFocusMode();
          break;
        case "metrics":
          // Quick metrics display
          console.log("\n=== SESSION METRICS ===\n");
          console.log("  Use /report for weekly report");
          break;
        case "report":
          console.log("\nWeekly report generation...");
          console.log("  (requires metrics.ts integration)");
          break;
        case "compact":
          await compactMemory();
          break;
        case "research":
          if (args.length > 0) {
            const result = await spawnSubAgent({ type: "research", task: args.join(" ") });
            console.log("\n" + result + "\n");
          } else {
            console.log("Usage: /research <topic>");
          }
          break;
        case "implement":
          if (args.length > 0) {
            const result = await spawnSubAgent({ type: "implementation", task: args.join(" ") });
            console.log("\n" + result + "\n");
          } else {
            console.log("Usage: /implement <task>");
          }
          break;
        case "refactor":
          if (args.length > 0) {
            const result = await spawnSubAgent({ type: "refactor", task: args.join(" ") });
            console.log("\n" + result + "\n");
          } else {
            console.log("Usage: /refactor <code/path>");
          }
          break;
        case "audit":
          if (args.length > 0) {
            const result = await spawnSubAgent({ type: "audit", task: args.join(" ") });
            console.log("\n" + result + "\n");
          } else {
            console.log("Usage: /audit <code/path>");
          }
          break;

        // Browser commands
        case "browser":
          const browserCmd = args[0];
          const browserArgs = args.slice(1);
          try {
            switch (browserCmd) {
              case "start":
                await startBrowser();
                console.log("Browser started");
                break;
              case "close":
                await closeBrowser();
                console.log("Browser closed");
                break;
              case "go":
                if (browserArgs[0]) {
                  console.log(await navigate(browserArgs[0]));
                } else {
                  console.log("Usage: /browser go <url>");
                }
                break;
              case "screenshot":
                const shot = await screenshot();
                console.log(`Screenshot saved: ${shot.path}`);
                break;
              case "click":
                if (browserArgs[0]) {
                  console.log(await click(browserArgs[0]));
                } else {
                  console.log("Usage: /browser click <selector>");
                }
                break;
              case "type":
                if (browserArgs.length >= 2) {
                  console.log(await browserType(browserArgs[0], browserArgs.slice(1).join(" ")));
                } else {
                  console.log("Usage: /browser type <selector> <text>");
                }
                break;
              case "content":
                const html = await getContent();
                console.log(html.substring(0, 2000) + (html.length > 2000 ? "..." : ""));
                break;
              case "text":
                if (browserArgs[0]) {
                  console.log(await getText(browserArgs[0]));
                } else {
                  console.log("Usage: /browser text <selector>");
                }
                break;
              case "wait":
                if (browserArgs[0]) {
                  console.log(await waitFor(browserArgs[0]));
                } else {
                  console.log("Usage: /browser wait <selector>");
                }
                break;
              case "eval":
                if (browserArgs[0]) {
                  const result = await evaluate(browserArgs.join(" "));
                  console.log(result);
                } else {
                  console.log("Usage: /browser eval <js>");
                }
                break;
              case "url":
                console.log(await getCurrentUrl());
                break;
              case "status":
                console.log(isBrowserActive() ? "Browser is active" : "Browser is not running");
                break;
              default:
                console.log("\nBrowser commands:");
                console.log("  /browser start          - Start browser");
                console.log("  /browser close          - Close browser");
                console.log("  /browser go <url>       - Navigate to URL");
                console.log("  /browser screenshot     - Take screenshot");
                console.log("  /browser click <sel>    - Click element");
                console.log("  /browser type <sel> <text> - Type into input");
                console.log("  /browser content        - Get page HTML");
                console.log("  /browser text <sel>     - Get element text");
                console.log("  /browser wait <sel>     - Wait for element");
                console.log("  /browser eval <js>      - Execute JavaScript");
                console.log("  /browser url            - Get current URL");
                console.log("  /browser status         - Check if running");
            }
          } catch (e) {
            console.error("Browser error:", e);
          }
          break;

        // Email commands
        case "email":
          const emailCmd = args[0];
          const emailArgs = args.slice(1);
          try {
            if (!isGmailConfigured()) {
              console.log("Gmail not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env");
              break;
            }

            switch (emailCmd) {
              case "inbox":
                const emails = await getInbox(parseInt(emailArgs[0]) || 10);
                console.log("\n=== INBOX ===\n");
                console.log(formatEmails(emails));
                break;

              case "search":
                if (emailArgs[0]) {
                  const results = await searchEmails(emailArgs.join(" "));
                  console.log("\n=== SEARCH RESULTS ===\n");
                  console.log(formatEmails(results));
                } else {
                  console.log("Usage: /email search <query>");
                }
                break;

              case "send":
                if (emailArgs.length >= 3) {
                  const [to, subject, ...bodyParts] = emailArgs;
                  const result = await sendEmail(to, subject, bodyParts.join(" "));
                  if (result.success) {
                    console.log(`✓ Email sent! ID: ${result.messageId}`);
                  } else {
                    console.log(`✗ Failed: ${result.error}`);
                  }
                } else {
                  console.log("Usage: /email send <to> <subject> <body>");
                }
                break;

              case "read":
                if (emailArgs[0]) {
                  const success = await markAsRead(emailArgs[0]);
                  console.log(success ? "✓ Marked as read" : "✗ Failed");
                } else {
                  console.log("Usage: /email read <message_id>");
                }
                break;

              case "delete":
                if (emailArgs[0]) {
                  const success = await deleteEmail(emailArgs[0]);
                  console.log(success ? "✓ Deleted" : "✗ Failed");
                } else {
                  console.log("Usage: /email delete <message_id>");
                }
                break;

              case "status":
                const hasTokens = await hasGmailTokens();
                console.log(`Gmail configured: ${isGmailConfigured() ? "yes" : "no"}`);
                console.log(`Tokens stored: ${hasTokens ? "yes" : "no"}`);
                if (!hasTokens) {
                  console.log("\nRun: bun run src/email.ts --auth");
                }
                break;

              default:
                console.log("\nEmail commands:");
                console.log("  /email inbox [N]        - Show last N emails (default 10)");
                console.log("  /email search <query>   - Search emails");
                console.log("  /email send <to> <subj> <body> - Send email");
                console.log("  /email read <id>        - Mark as read");
                console.log("  /email delete <id>      - Delete email");
                console.log("  /email status           - Check Gmail setup");
            }
          } catch (e) {
            console.error("Email error:", e);
          }
          break;
        case "help":
          console.log("\nCommands:");
          console.log("  /goals        - Show active goals");
          console.log("  /actions      - Show pending actions");
          console.log("  /state        - Show agent state");
          console.log("  /decompose    - Decompose complex goals");
          console.log("  /hierarchy ID - Show goal hierarchy");
          console.log("  /focus NAME   - Enable focus mode for project");
          console.log("  /unfocus      - Disable focus mode");
          console.log("  /compact      - Compress/archive old memory");
          console.log("  /research X   - Spawn research agent");
          console.log("  /implement X  - Spawn implementation agent");
          console.log("  /refactor X   - Spawn refactor agent");
          console.log("  /audit X      - Spawn audit agent");
          console.log("  /metrics      - Show session metrics");
          console.log("  /report       - Generate weekly report");
          console.log("  /help         - Show this help");
          console.log("  /exit         - Exit REPL");
          break;
        case "exit":
        case "quit":
          rl.close();
          return;
        default:
          console.log("Unknown command. Type /help for available commands.");
      }
    } else {
      // Regular message
      const response = await handleMessage(input);
      console.log("\n" + response + "\n");
    }
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // No args - start REPL
    await startRepl();
    return;
  }

  const flag = args[0];

  switch (flag) {
    case "--repl":
    case "-i":
      await startRepl();
      break;

    case "--goals":
      await showGoals();
      break;

    case "--actions":
      await showActions();
      break;

    case "--state":
      await showState();
      break;

    case "--decompose":
      const count = await decomposeAllComplexGoals();
      console.log(`Decomposed ${count} goals`);
      break;

    case "--hierarchy":
      if (args[1]) {
        await showHierarchy(args[1]);
      } else {
        console.log("Usage: cli.ts --hierarchy <goal_id>");
      }
      break;

    case "--help":
    case "-h":
      console.log(`
Claude Relay CLI

Usage:
  cli.ts [message]          Send a message
  cli.ts --repl             Start interactive REPL
  cli.ts --goals            Show active goals
  cli.ts --actions          Show pending actions
  cli.ts --state            Show agent state
  cli.ts --decompose        Decompose complex goals
  cli.ts --hierarchy ID     Show goal hierarchy

REPL Commands:
  /goals, /actions, /state, /decompose, /hierarchy, /focus, /unfocus
  /compact, /research, /implement, /refactor, /audit, /metrics, /report, /help, /exit
      `);
      break;

    default:
      // Treat as a message
      const message = args.join(" ");
      const response = await handleMessage(message);
      console.log(response);
  }
}

main().catch(console.error);
