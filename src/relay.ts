/**
 * Claude Code Telegram Relay
 *
 * Relay that connects Telegram to Claude Code CLI with:
 * - Threaded conversations (DMs + Telegram Topics)
 * - Three-layer memory (soul, global facts, thread context)
 * - Voice transcription via Groq Whisper API
 * - Intent-based memory management ([REMEMBER:]/[FORGET:]/[GOAL:]/[DONE:] tags)
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink, open, readdir } from "fs/promises";
import { join, basename } from "path";
import { createClient } from "@supabase/supabase-js";
import { Cron } from "croner";
import { searchMemoryLocal, generateEmbedding } from "./embed-local.ts";
// Email operations now use provider abstraction
import {
  fetchEmailContext,
  formatEmailContextForHeartbeat,
  getAuthorizedEmailAccounts,
  listEmailsForRelay,
  getEmailForRelay,
  sendEmailForRelay,
  validateEmailWithProvider,
  isValidProviderType,
  getProviderDisplayName,
  sanitizeDisplayName,
  parseOAuthError,
  type RelayEmailMessage,
} from "./email/index.ts";
import { getEmailProviderFactory, getAuthorizedProviders } from "./email/provider-factory.ts";
import type { EmailProvider, EmailMessage, EmailProviderType } from "./email/types.ts";
import { getAuthUrl as getGoogleAuthUrl, exchangeCodeForToken as exchangeGoogleCode } from "./google-oauth.ts";
import { getAuthUrl as getMicrosoftAuthUrl, exchangeCodeForToken as exchangeMicrosoftCode } from "./microsoft-oauth.ts";
import { startTokenRefreshScheduler, stopTokenRefreshScheduler } from "./auth/index.ts";
import { getTokenManager, type OAuthToken } from "./auth/token-manager.ts";
import { parseEmailAddArgs, parseEmailVerifyArgs, EMAIL_ADD_USAGE } from "./utils/command-parser.ts";
import { circuitBreakers, CircuitOpenError } from "./utils/circuit-breaker.ts";

// ============================================================
// THREAD CONTEXT TYPES
// ============================================================

interface ThreadInfo {
  dbId: string;
  chatId: number;
  threadId: number | null;
  title: string;
  sessionId: string | null;
  summary: string;
  messageCount: number;
}

type CustomContext = Context & { threadInfo?: ThreadInfo };

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR =
  process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const TTS_PROVIDER = process.env.TTS_PROVIDER || (ELEVENLABS_API_KEY ? "elevenlabs" : "edge");
const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || "en-US-AriaNeural";
const EDGE_TTS_SPEED = process.env.EDGE_TTS_SPEED || "1.3";
const EDGE_TTS_PATH = process.env.EDGE_TTS_PATH || "/home/radxa/.local/bin/edge-tts";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";

const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Security: sanitize filenames to prevent path traversal
function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\]/g, "_").replace(/\.\./g, "_");
}

// Claude CLI limits
const CLAUDE_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 min of no output = stuck
const MAX_OUTPUT_SIZE = 3 * 1024 * 1024; // 3MB

// Circuit breakers for external APIs (with observability logging)
const groqCircuitBreaker = circuitBreakers.get("groq-whisper", {
  failureThreshold: 3,
  resetTimeout: 60000, // 1 minute
  onOpen: (name, failures) => {
    console.log(`[CircuitBreaker:${name}] OPEN after ${failures} failures - Groq API unavailable`);
    logEventV2("circuit_open", `Circuit breaker OPEN: ${name}`, { service: "groq", failures }).catch(() => {});
  },
  onClose: (name) => {
    console.log(`[CircuitBreaker:${name}] CLOSED - Groq API recovered`);
    logEventV2("circuit_close", `Circuit breaker CLOSED: ${name}`, { service: "groq" }).catch(() => {});
  },
});

const elevenLabsCircuitBreaker = circuitBreakers.get("elevenlabs-tts", {
  failureThreshold: 3,
  resetTimeout: 60000, // 1 minute
  onOpen: (name, failures) => {
    console.log(`[CircuitBreaker:${name}] OPEN after ${failures} failures - ElevenLabs TTS unavailable`);
    logEventV2("circuit_open", `Circuit breaker OPEN: ${name}`, { service: "elevenlabs", failures }).catch(() => {});
  },
  onClose: (name) => {
    console.log(`[CircuitBreaker:${name}] CLOSED - ElevenLabs TTS recovered`);
    logEventV2("circuit_close", `Circuit breaker CLOSED: ${name}`, { service: "elevenlabs" }).catch(() => {});
  },
});

// Kill orphaned child processes left behind after Claude CLI timeout.
// Finds processes whose parent was the killed Claude process (now reparented to PID 1)
// and matches common patterns from skills/tools that Claude spawns.
async function killOrphanedProcesses(claudePid: number): Promise<void> {
  try {
    // Find child processes that were spawned by the Claude process.
    // After killing Claude, children get reparented to PID 1 (launchd on macOS).
    // We look for python/node/bun processes started from .claude/skills or similar paths
    // that are now orphaned (PPID=1) and started around the same time.
    const result = Bun.spawnSync(["bash", "-c",
      `ps -eo pid,ppid,lstart,command | grep -E '(scripts/(sheets|gcal|gmail|auth|gdrive|gchat|gslides|gdocs)\\.py|.claude/skills/)' | grep -v grep`
    ]);
    const output = new TextDecoder().decode(result.stdout).trim();
    if (!output) return;

    const pidsToKill: number[] = [];
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)/);
      if (match) {
        const pid = parseInt(match[1]);
        if (pid !== process.pid) pidsToKill.push(pid);
      }
    }

    for (const pid of pidsToKill) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`Killed orphaned process ${pid}`);
      } catch {
        // Process already exited — ignore
      }
    }

    if (pidsToKill.length > 0) {
      console.log(`Cleaned up ${pidsToKill.length} orphaned process(es) after timeout`);
      await logEventV2("orphan_process_cleanup", `Cleaned up ${pidsToKill.length} orphaned processes`, {
        pids: pidsToKill,
        parent_claude_pid: claudePid
      });
    }
  } catch {
    // Best-effort cleanup — don't let this break the flow
  }
}

// Rate limiting: max messages per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 messages per minute
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return false;
}

// Cleanup stale rate limit entries (users with no recent activity)
function cleanupRateLimitMap(): number {
  const now = Date.now();
  let removed = 0;
  for (const [userId, timestamps] of rateLimitMap.entries()) {
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      rateLimitMap.delete(userId);
      removed++;
    } else if (recent.length !== timestamps.length) {
      rateLimitMap.set(userId, recent);
    }
  }
  return removed;
}

// ============================================================
// SKILL REGISTRY (auto-generated at startup)
// ============================================================

const SKILLS_DIR = join(process.env.HOME || "~", ".claude", "skills");

async function buildSkillRegistry(): Promise<string> {
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skills: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(SKILLS_DIR, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillPath, "utf-8");
      } catch {
        continue; // No SKILL.md — skip
      }

      // Extract description from YAML frontmatter or first heading
      let description = "";
      const yamlMatch = content.match(/^---\n[\s\S]*?description:\s*\|?\s*\n?\s*(.+?)(?:\n\s{2,}\S|\n[a-z]|\n---)/m);
      if (yamlMatch) {
        description = yamlMatch[1].trim();
      } else {
        const inlineMatch = content.match(/description:\s*"?([^"\n]+)"?/);
        if (inlineMatch) {
          description = inlineMatch[1].trim();
        }
      }

      // Fallback: use first non-heading, non-empty line
      if (!description) {
        const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
        description = lines[0]?.trim() || entry.name;
      }

      // Strip leftover YAML quotes and cap at first sentence for brevity
      description = description.replace(/^["']|["']$/g, "");
      const firstSentence = description.match(/^[^.!]+[.!]/)?.[0] || description;
      skills.push(`- ${entry.name}: ${firstSentence}`);
    }

    if (skills.length === 0) return "";
    return `AVAILABLE SKILLS (read the full SKILL.md in ~/.claude/skills/<name>/ before using):\n${skills.join("\n")}`;
  } catch {
    return "";
  }
}

// Loaded once at startup, reused in every prompt
let skillRegistry = "";

// Heartbeat timer — started after bot.start(), cleared on shutdown
let heartbeatTimer: Timer | null = null;

// ============================================================
// SUPABASE
// ============================================================

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

// ============================================================
// SUPABASE v2: Thread-aware helpers
// ============================================================

interface ThreadRecord {
  id: string;
  telegram_chat_id: number;
  telegram_thread_id: number | null;
  claude_session_id: string | null;
  title: string;
  summary: string;
  message_count: number;
}

async function getOrCreateThread(
  chatId: number,
  threadId: number | null,
  title: string = "DM"
): Promise<ThreadRecord | null> {
  if (!supabase) return null;
  try {
    // Try to find existing thread
    let query = supabase
      .from("threads")
      .select("*")
      .eq("telegram_chat_id", chatId);

    if (threadId != null) {
      query = query.eq("telegram_thread_id", threadId);
    } else {
      query = query.is("telegram_thread_id", null);
    }

    const { data: existing } = await query.limit(1).single();
    if (existing) return existing as ThreadRecord;

    // Create new thread
    const { data: created, error } = await supabase
      .from("threads")
      .insert({
        telegram_chat_id: chatId,
        telegram_thread_id: threadId,
        title,
      })
      .select()
      .single();

    if (error) {
      console.error("Create thread error:", error);
      return null;
    }
    return created as ThreadRecord;
  } catch (e) {
    console.error("getOrCreateThread error:", e);
    return null;
  }
}

async function updateThreadSession(
  threadDbId: string,
  sessionId: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("threads")
      .update({ claude_session_id: sessionId, updated_at: new Date().toISOString() })
      .eq("id", threadDbId);
  } catch (e) {
    console.error("updateThreadSession error:", e);
  }
}

async function updateThreadSummary(
  threadDbId: string,
  summary: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("threads")
      .update({ summary, updated_at: new Date().toISOString() })
      .eq("id", threadDbId);
  } catch (e) {
    console.error("updateThreadSummary error:", e);
  }
}

async function incrementThreadMessageCount(threadDbId: string): Promise<number> {
  if (!supabase) return 0;
  try {
    // Atomic increment using raw SQL via rpc to avoid TOCTOU race
    const { data, error } = await supabase.rpc("increment_thread_message_count", {
      p_thread_id: threadDbId,
    });
    if (error) {
      // Fallback: read-increment-write (non-atomic but functional)
      const { data: row } = await supabase
        .from("threads")
        .select("message_count")
        .eq("id", threadDbId)
        .single();
      const newCount = (row?.message_count || 0) + 1;
      await supabase
        .from("threads")
        .update({ message_count: newCount })
        .eq("id", threadDbId);
      return newCount;
    }
    return data ?? 0;
  } catch (e) {
    console.error("incrementThreadMessageCount error:", e);
    return 0;
  }
}

async function insertThreadMessage(
  threadDbId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("thread_messages")
      .insert({ thread_id: threadDbId, role, content });
  } catch (e) {
    console.error("insertThreadMessage error:", e);
  }
}

async function getRecentThreadMessages(
  threadDbId: string,
  limit: number = 5
): Promise<Array<{ role: string; content: string }>> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("thread_messages")
      .select("role, content")
      .eq("thread_id", threadDbId)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data || []).reverse();
  } catch (e) {
    console.error("getRecentThreadMessages error:", e);
    return [];
  }
}

async function getMemoryContext(): Promise<string[]> {
  if (!supabase) return [];
  try {
    // Try RPC first (global_memory)
    const { data: rpcFacts } = await supabase.rpc("get_facts");
    if (rpcFacts && rpcFacts.length > 0) {
      return rpcFacts.map((m: { content: string }) => m.content);
    }

    // Fallback: query global_memory table directly
    const { data: memoryFacts } = await supabase
      .from("global_memory")
      .select("content")
      .eq("type", "fact")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(20);

    if (memoryFacts && memoryFacts.length > 0) {
      return memoryFacts.map((m: { content: string }) => m.content);
    }

    return [];
  } catch (e) {
    console.error("getMemoryContext error:", e);
    return [];
  }
}

async function insertMemory(
  content: string,
  type: string = "fact",
  sourceThreadId?: string,
  deadline?: string | null,
  priority?: number
): Promise<boolean> {
  if (!supabase) return false;

  // Validate content
  if (!content || content.trim().length === 0) {
    console.warn("insertMemory: empty content rejected");
    return false;
  }

  // Validate type is one of the allowed values
  const validTypes = ['fact', 'goal', 'action', 'strategy', 'reflection', 'preference', 'completed_goal', 'system_event'];
  if (!validTypes.includes(type)) {
    console.warn(`insertMemory: invalid type "${type}" rejected`);
    return false;
  }

  // Check for unbalanced brackets (potential parsing corruption)
  const openBrackets = (content.match(/\[/g) || []).length;
  const closeBrackets = (content.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) {
    console.warn(`insertMemory: unbalanced brackets in content rejected: ${content.substring(0, 50)}...`);
    return false;
  }

  try {
    const row: Record<string, unknown> = {
      content,
      type,
      status: 'active',
    };
    // global_memory has source_thread_id column directly
    if (sourceThreadId) {
      row.source_thread_id = sourceThreadId;
    }
    if (deadline) {
      const parsed = new Date(deadline);
      if (!isNaN(parsed.getTime())) {
        row.deadline = parsed.toISOString();
      } else {
        console.warn(`Could not parse deadline: "${deadline}"`);
      }
    }
    if (priority !== undefined) {
      row.priority = priority;
    }
    // Use global_memory directly (has full schema including source_thread_id)
    const { error } = await supabase.from("global_memory").insert(row);
    if (error) {
      console.error("insertMemory error:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("insertMemory error:", e);
    return false;
  }
}

async function deleteMemory(searchText: string): Promise<boolean> {
  if (!supabase) {
    console.warn("deleteMemory: no supabase client");
    return false;
  }
  if (!searchText || searchText.length > 200) {
    console.warn(`deleteMemory: invalid search text (length=${searchText?.length || 0})`);
    return false;
  }
  try {
    // Use global_memory directly (has full schema)
    const { data: memoryItems, error: memErr } = await supabase
      .from("global_memory")
      .select("id, content, type")
      .in("type", ["fact", "goal", "preference", "strategy", "action", "reflection", "reminder", "note"])
      .eq("status", "active")
      .limit(500);

    if (!memErr && memoryItems) {
      const match = memoryItems.find((m: { id: string; content: string }) =>
        m.content.toLowerCase().includes(searchText.toLowerCase())
      );
      if (match) {
        await supabase.from("global_memory").delete().eq("id", match.id);
        console.log(`Forgot memory [${(match as any).type}]: ${match.content}`);
        return true;
      }
    }

    const total = memoryItems?.length || 0;
    console.warn(`deleteMemory: no match found for "${searchText}" (searched ${total} entries)`);
    return false;
  } catch (e) {
    console.error("deleteMemory error:", e);
    return false;
  }
}

async function getActiveGoals(): Promise<
  Array<{ content: string; deadline: string | null; priority: number }>
> {
  if (!supabase) return [];
  try {
    // Try RPC first (global_memory)
    const { data: rpcGoals } = await supabase.rpc("get_active_goals");
    if (rpcGoals && rpcGoals.length > 0) {
      return rpcGoals.map(
        (g: { content: string; deadline: string | null; priority: number }) => ({
          content: g.content,
          deadline: g.deadline,
          priority: g.priority,
        })
      );
    }

    // Fallback: query global_memory table directly
    const { data: memoryGoals } = await supabase
      .from("global_memory")
      .select("content, deadline, priority")
      .eq("type", "goal")
      .eq("status", "active")
      .order("priority", { ascending: false })
      .limit(20);

    if (memoryGoals && memoryGoals.length > 0) {
      return memoryGoals.map((g: any) => ({
        content: g.content,
        deadline: g.deadline,
        priority: g.priority || 3,
      }));
    }

    return [];
  } catch (e) {
    console.error("getActiveGoals error:", e);
    return [];
  }
}

async function completeGoal(searchText: string): Promise<boolean> {
  if (!supabase) return false;
  if (!searchText || searchText.length > 200) return false;
  try {
    // Try memory table first (primary table with full schema)
    const { data: memoryGoals } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "goal")
      .eq("status", "active")
      .limit(200);

    let match = memoryGoals?.find((g: { id: string; content: string }) =>
      g.content.toLowerCase().includes(searchText.toLowerCase())
    );

    if (match) {
      await supabase
        .from("memory")
        .update({ type: "completed_goal", status: "completed" })
        .eq("id", match.id);
      console.log(`Goal completed (memory): ${match.content}`);
      return true;
    }

    // Fallback: try global_memory
    const { data: globalGoals } = await supabase
      .from("global_memory")
      .select("id, content")
      .eq("type", "goal")
      .is("completed_at", null)
      .limit(100);

    match = globalGoals?.find((g: { id: string; content: string }) =>
      g.content.toLowerCase().includes(searchText.toLowerCase())
    );

    if (match) {
      await supabase
        .from("global_memory")
        .update({ type: "completed_goal", completed_at: new Date().toISOString() })
        .eq("id", match.id);
      console.log(`Goal completed (global_memory): ${match.content}`);
      return true;
    }

    return false;
  } catch (e) {
    console.error("completeGoal error:", e);
    return false;
  }
}

async function getRelevantMemory(
  query: string
): Promise<Array<{ content: string; type: string; similarity: number }>> {
  if (!supabase) return [];

  // Primary: Use local semantic search (generates embedding, uses RPC)
  try {
    const results = await searchMemoryLocal(query, 10, 0.5);
    if (results && results.length > 0) {
      return results;
    }
  } catch (e) {
    // Local search failed, try other fallbacks
  }

  // Fallback 1: Direct text search via RPC
  try {
    const { data, error } = await supabase.rpc("search_memory_text", {
      search_query: query,
      match_count: 10,
    });
    if (!error && data && data.length > 0) {
      return data.map((r: any) => ({
        content: r.content,
        type: r.type,
        similarity: r.rank || 0.5,
      }));
    }
  } catch (e) {
    // RPC doesn't exist, continue to fallback
  }

  // Fallback 2: Simple ILIKE search
  try {
    const word = query.split(" ")[0];
    const { data, error } = await supabase
      .from("global_memory")
      .select("content, type")
      .ilike("content", `%${word}%`)
      .in("type", ["fact", "goal", "preference", "strategy", "action"])
      .eq("status", "active")
      .limit(5);
    if (!error && data && data.length > 0) {
      return data.map((r: any) => ({
        content: r.content,
        type: r.type,
        similarity: 0.4,
      }));
    }
  } catch (e) {
    // All fallbacks failed
  }

  return [];
}

async function getActiveSoul(): Promise<string> {
  if (!supabase) return "You are a helpful, concise assistant responding via Telegram.";
  try {
    const { data } = await supabase
      .from("bot_soul")
      .select("content")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();
    return data?.content || "You are a helpful, concise assistant responding via Telegram.";
  } catch (e) {
    return "You are a helpful, concise assistant responding via Telegram.";
  }
}

async function setSoul(content: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    // Deactivate all existing souls
    await supabase.from("bot_soul").update({ is_active: false }).eq("is_active", true);
    // Insert new active soul
    await supabase.from("bot_soul").insert({ content, is_active: true });
    return true;
  } catch (e) {
    console.error("setSoul error:", e);
    return false;
  }
}

async function clearThreadSession(threadDbId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    await supabase
      .from("threads")
      .update({ claude_session_id: null, updated_at: new Date().toISOString() })
      .eq("id", threadDbId);
    return true;
  } catch (e) {
    console.error("clearThreadSession error:", e);
    return false;
  }
}

async function logEventV2(
  event: string,
  message?: string,
  metadata?: Record<string, unknown>,
  threadDbId?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("logs_v2")
      .insert({
        event,
        message,
        metadata: metadata || {},
        thread_id: threadDbId || null,
      });
  } catch (e) {
    console.error("logEventV2 error:", e);
  }
}


// ============================================================
// SUPABASE v2.1: Heartbeat & Cron helpers
// ============================================================

interface HeartbeatConfig {
  id: string;
  interval_minutes: number;
  active_hours_start: string;
  active_hours_end: string;
  timezone: string;
  enabled: boolean;
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  schedule_type: 'cron' | 'interval' | 'once';
  prompt: string;
  target_thread_id: string | null;
  enabled: boolean;
  source: 'user' | 'agent' | 'file';
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
}

async function getHeartbeatConfig(): Promise<HeartbeatConfig | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("heartbeat_config")
      .select("*")
      .limit(1)
      .single();
    return data as HeartbeatConfig | null;
  } catch (e) {
    console.error("getHeartbeatConfig error:", e);
    return null;
  }
}

async function getEnabledCronJobs(): Promise<CronJob[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("cron_jobs")
      .select("*")
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    return (data || []) as CronJob[];
  } catch (e) {
    console.error("getEnabledCronJobs error:", e);
    return [];
  }
}

async function updateCronJobLastRun(jobId: string, nextRunAt?: string): Promise<void> {
  if (!supabase) return;
  try {
    const update: Record<string, unknown> = {
      last_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (nextRunAt) update.next_run_at = nextRunAt;
    await supabase.from("cron_jobs").update(update).eq("id", jobId);
  } catch (e) {
    console.error("updateCronJobLastRun error:", e);
  }
}

async function disableCronJob(jobId: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from("cron_jobs")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    console.error("disableCronJob error:", e);
  }
}

// ============================================================
// SUPABASE v2.2: Cron Management helpers (Phase 10)
// ============================================================

function detectScheduleType(schedule: string): 'cron' | 'interval' | 'once' | null {
  const trimmed = schedule.trim().toLowerCase();
  if (trimmed.startsWith("every ")) return "interval";
  if (trimmed.startsWith("in ")) return "once";
  // Check for 5-field cron expression
  const fields = trimmed.split(/\s+/);
  if (fields.length === 5 && fields.every(f => /^[\d\*\/\-,]+$/.test(f))) return "cron";
  return null;
}

async function createCronJob(
  name: string,
  schedule: string,
  scheduleType: 'cron' | 'interval' | 'once',
  prompt: string,
  targetThreadId?: string,
  source: 'user' | 'agent' | 'file' = 'user'
): Promise<CronJob | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("cron_jobs")
      .insert({
        name,
        schedule,
        schedule_type: scheduleType,
        prompt,
        target_thread_id: targetThreadId || null,
        enabled: true,
        source,
      })
      .select()
      .single();

    if (error) {
      console.error("createCronJob error:", error);
      return null;
    }

    // Compute initial next_run_at
    const job = data as CronJob;
    const nextRun = computeNextRun(job);
    if (nextRun) {
      await supabase
        .from("cron_jobs")
        .update({ next_run_at: nextRun })
        .eq("id", job.id);
    }

    return job;
  } catch (e) {
    console.error("createCronJob error:", e);
    return null;
  }
}

async function getAllCronJobs(): Promise<CronJob[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("cron_jobs")
      .select("*")
      .order("created_at", { ascending: true });
    return (data || []) as CronJob[];
  } catch (e) {
    console.error("getAllCronJobs error:", e);
    return [];
  }
}

async function deleteCronJob(jobId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from("cron_jobs")
      .delete()
      .eq("id", jobId);
    return !error;
  } catch (e) {
    console.error("deleteCronJob error:", e);
    return false;
  }
}

// ============================================================
// CRON SCHEDULER ENGINE (Phase 9)
// ============================================================

let cronTimer: Timer | null = null;
let cronRunning = false;
const CRON_TICK_INTERVAL_MS = 10 * 60 * 1000; // Check every 10 minutes

function computeNextRun(job: CronJob): string | null {
  const now = new Date();

  if (job.schedule_type === "cron") {
    try {
      const cronInstance = new Cron(job.schedule);
      const nextRun = cronInstance.nextRun();
      return nextRun ? nextRun.toISOString() : null;
    } catch (err) {
      console.error(`[Cron] Invalid cron expression for job ${job.id} (${job.name}): ${job.schedule}`, err);
      return null;
    }
  }

  if (job.schedule_type === "interval") {
    // Support: every 1d, every 7d, every 2h, every 30m, every 1d12h, etc.
    const match = job.schedule.match(/every\s+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?/i);
    if (!match) {
      console.error(`[Cron] Invalid interval format for job ${job.id}: ${job.schedule}`);
      return null;
    }
    const days = parseInt(match[1] || "0", 10);
    const hours = parseInt(match[2] || "0", 10);
    const minutes = parseInt(match[3] || "0", 10);
    const intervalMs = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;

    if (intervalMs === 0) {
      console.error(`[Cron] Zero interval for job ${job.id}: ${job.schedule}`);
      return null;
    }

    const baseTime = job.last_run_at ? new Date(job.last_run_at) : now;
    const nextRun = new Date(baseTime.getTime() + intervalMs);
    return nextRun.toISOString();
  }

  if (job.schedule_type === "once") {
    const match = job.schedule.match(/in\s+(?:(\d+)h)?(?:(\d+)m)?/i);
    if (!match) {
      console.error(`[Cron] Invalid once format for job ${job.id}: ${job.schedule}`);
      return null;
    }
    const hours = parseInt(match[1] || "0", 10);
    const minutes = parseInt(match[2] || "0", 10);
    const delayMs = (hours * 60 + minutes) * 60 * 1000;

    if (delayMs === 0) {
      console.error(`[Cron] Zero delay for one-shot job ${job.id}: ${job.schedule}`);
      return null;
    }

    const scheduledTime = new Date(new Date(job.created_at).getTime() + delayMs);

    // If scheduled time is in the past and job has never run, it's due now
    if (scheduledTime < now && !job.last_run_at) {
      return now.toISOString();
    }

    return scheduledTime.toISOString();
  }

  return null;
}

function isJobDue(job: CronJob): boolean {
  const now = new Date();

  if (job.next_run_at) {
    return new Date(job.next_run_at) <= now;
  }

  // First time: compute next_run_at
  const nextRun = computeNextRun(job);
  if (!nextRun) return false;

  return new Date(nextRun) <= now;
}

async function getThreadInfoForCronJob(job: CronJob): Promise<ThreadInfo | undefined> {
  if (!job.target_thread_id) return undefined;

  const { data, error } = await supabase!
    .from("threads")
    .select("*")
    .eq("id", job.target_thread_id)
    .single();

  if (error || !data) {
    console.error(`[Cron] Target thread not found for job ${job.id}:`, error);
    return undefined;
  }

  return {
    dbId: data.id,
    chatId: data.telegram_chat_id,
    threadId: data.telegram_thread_id,
    title: data.title,
    sessionId: data.claude_session_id,
    summary: data.summary || "",
    messageCount: data.message_count || 0,
  };
}

async function sendCronResultToTelegram(
  message: string,
  job: CronJob,
  threadInfo?: ThreadInfo
): Promise<void> {
  const chatId = threadInfo ? threadInfo.chatId : parseInt(ALLOWED_USER_ID);
  const threadId = threadInfo?.threadId;

  const escapedName = job.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const prefix = `<b>[Cron: ${escapedName}]</b>\n\n`;
  const html = prefix + markdownToTelegramHtml(message);

  const chunks: string[] = [];
  if (html.length <= 4000) {
    chunks.push(html);
  } else {
    const lines = html.split("\n");
    let currentChunk = "";
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > 4000) {
        chunks.push(currentChunk);
        currentChunk = line;
      } else {
        currentChunk += (currentChunk ? "\n" : "") + line;
      }
    }
    if (currentChunk) chunks.push(currentChunk);
  }

  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        message_thread_id: threadId,
      });
    } catch (err: any) {
      if (err.description?.includes("can't parse entities")) {
        const stripped = chunk.replace(/<[^>]*>/g, "");
        await bot.api.sendMessage(chatId, stripped, { message_thread_id: threadId });
      } else {
        console.error("[Cron] Failed to send message:", err);
      }
    }
  }
}

async function executeCronJob(job: CronJob): Promise<void> {
  await logEventV2("cron_executed", `Cron job fired: ${job.name}`, {
    job_id: job.id,
    job_name: job.name,
    schedule: job.schedule,
    schedule_type: job.schedule_type,
  });

  const threadInfo = await getThreadInfoForCronJob(job);

  // Build prompt
  const soul = await getActiveSoul();
  const memoryFacts = await getMemoryContext();
  const activeGoals = await getActiveGoals();

  const timeZone = "America/Sao_Paulo";
  const timeString = new Date().toLocaleString("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  });

  let prompt = soul + `\n\nCurrent time: ${timeString}\n\n`;

  if (memoryFacts.length > 0) {
    prompt += "THINGS I KNOW ABOUT THE USER:\n";
    prompt += memoryFacts.map((m) => `- ${m}`).join("\n");
    prompt += "\n\n";
  }

  if (activeGoals.length > 0) {
    prompt += "ACTIVE GOALS:\n";
    prompt += activeGoals
      .map((g) => {
        let line = `- ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
    prompt += "\n\n";
  }

  if (threadInfo && threadInfo.summary) {
    prompt += `THREAD CONTEXT:\n${threadInfo.summary}\n\n`;
  }

  prompt += `SCHEDULED TASK:\n${job.prompt}`;

  // Call Claude
  let text = "";
  let sessionId = threadInfo?.sessionId;

  try {
    const result = await callClaude(prompt, threadInfo);
    text = result.text;
    sessionId = result.sessionId;
  } catch (err: any) {
    await logEventV2("cron_error", `Cron execution failed for ${job.name}: ${err.message}`, {
      job_id: job.id,
      error: err.message,
    });
    return;
  }

  if (!text || text.trim() === "") {
    await logEventV2("cron_error", `Cron job ${job.name} returned empty response`, {
      job_id: job.id,
    });
    return;
  }

  // Update session if needed
  if (threadInfo && sessionId && sessionId !== threadInfo.sessionId) {
    await updateThreadSession(threadInfo.dbId, sessionId);
  }

  // Process intents
  const cleanResponse = await processIntents(text, threadInfo?.dbId);

  // Strip voice tags
  const finalMessage = cleanResponse.replace(/\[VOICE_REPLY\]/gi, "").trim();

  // Deliver
  await sendCronResultToTelegram(finalMessage, job, threadInfo);

  // Update next_run_at
  const nextRun = computeNextRun(job);
  await updateCronJobLastRun(job.id, nextRun || undefined);

  // Auto-disable one-shot jobs
  if (job.schedule_type === "once") {
    await disableCronJob(job.id);
  }

  await logEventV2("cron_delivered", `Cron result delivered: ${job.name}`, {
    job_id: job.id,
    message_length: finalMessage.length,
  });
}

async function cronTick(): Promise<void> {
  // Guard against overlapping ticks
  if (cronRunning) {
    console.log("[Cron] Tick skipped (previous tick still running)");
    return;
  }

  cronRunning = true;

  try {
    const jobs = await getEnabledCronJobs();

    if (jobs.length === 0) {
      return;
    }

    console.log(`[Cron] Tick: checking ${jobs.length} enabled job(s)`);

    for (const job of jobs) {
      try {
        // Ensure next_run_at is computed
        if (!job.next_run_at) {
          const nextRun = computeNextRun(job);
          if (nextRun) {
            await updateCronJobLastRun(job.id, nextRun);
            job.next_run_at = nextRun; // Update in-memory for this tick
          } else {
            console.error(`[Cron] Could not compute next_run_at for job ${job.id}`);
            continue;
          }
        }

        // Check if due
        if (isJobDue(job)) {
          console.log(`[Cron] Executing due job: ${job.name} (${job.id})`);
          await executeCronJob(job);
        }
      } catch (err: any) {
        await logEventV2("cron_error", `Cron tick error for job ${job.name}: ${err.message}`, {
          job_id: job.id,
          error: err.message,
          stack: err.stack,
        });
        console.error(`[Cron] Error executing job ${job.id}:`, err);
      }
    }
  } finally {
    cronRunning = false;
  }
}

function startCronScheduler(): void {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = setInterval(cronTick, CRON_TICK_INTERVAL_MS);
  console.log("Cron scheduler: started (checking every 10min)");
}

function stopCronScheduler(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
    console.log("Cron scheduler: stopped");
  }
}

// ============================================================
// HEARTBEAT TIMER (Infrastructure — Phase 6)
// ============================================================

/**
 * Clean up orphaned files in uploads and temp directories
 *
 * Removes files older than 1 hour that weren't cleaned up due to crashes/errors.
 * Called at the start of each heartbeat cycle.
 */
async function cleanupOrphanedFiles(): Promise<{ uploads: number; temp: number }> {
  const ONE_HOUR_AGO = Date.now() - 60 * 60 * 1000;
  let uploadsCleaned = 0;
  let tempCleaned = 0;

  // Clean uploads directory
  try {
    const uploadsFiles = await readdir(UPLOADS_DIR);
    for (const file of uploadsFiles) {
      const filePath = join(UPLOADS_DIR, file);
      try {
        const stat = await Bun.file(filePath).exists().then(() => Bun.file(filePath));
        // @ts-ignore - Bun.file has lastModified
        const lastModified = (await Bun.file(filePath).text().catch(() => null)) ? Date.now() : 0;
        // Use file name timestamp as fallback (files are named with timestamps)
        const timestampMatch = file.match(/(\d{13})/);
        const fileTime = timestampMatch ? parseInt(timestampMatch[1]) : 0;
        if (fileTime > 0 && fileTime < ONE_HOUR_AGO) {
          await unlink(filePath).catch(() => {});
          uploadsCleaned++;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Directory doesn't exist or can't read
  }

  // Clean temp directory
  try {
    const tempFiles = await readdir(TEMP_DIR);
    for (const file of tempFiles) {
      const filePath = join(TEMP_DIR, file);
      try {
        // Use file name timestamp as fallback
        const timestampMatch = file.match(/(\d{13})/);
        const fileTime = timestampMatch ? parseInt(timestampMatch[1]) : 0;
        if (fileTime > 0 && fileTime < ONE_HOUR_AGO) {
          await unlink(filePath).catch(() => {});
          tempCleaned++;
        }
      } catch {
        // Skip files we can't process
      }
    }
  } catch {
    // Directory doesn't exist or can't read
  }

  if (uploadsCleaned > 0 || tempCleaned > 0) {
    console.log(`Cleanup: removed ${uploadsCleaned} orphaned uploads, ${tempCleaned} orphaned temp files`);
    await logEventV2("orphan_cleanup", "Cleaned orphaned files", {
      uploads_cleaned: uploadsCleaned,
      temp_cleaned: tempCleaned,
    });
  }

  return { uploads: uploadsCleaned, temp: tempCleaned };
}

/**
 * Check disk usage and log to observability
 *
 * Returns disk usage info for the root partition and the relay directory.
 * Called at each heartbeat for monitoring disk space trends.
 */
async function checkDiskUsage(): Promise<{
  totalGB: number;
  usedGB: number;
  availableGB: number;
  usedPercent: number;
  relayDirMB: number;
}> {
  try {
    // Get root partition usage
    const dfProc = spawn(["df", "-BG", "/"]);
    const dfText = await new Response(dfProc.stdout).text();
    await dfProc.exited;

    // Parse df output: Filesystem, Size, Used, Available, Use%, Mounted on
    const lines = dfText.trim().split("\n");
    const dataLine = lines[1]?.split(/\s+/);
    const totalGB = parseInt(dataLine?.[1] || "0");
    const usedGB = parseInt(dataLine?.[2] || "0");
    const availableGB = parseInt(dataLine?.[3] || "0");
    const usedPercent = parseInt(dataLine?.[4]?.replace("%", "") || "0");

    // Get relay directory size
    let relayDirMB = 0;
    try {
      const duProc = spawn(["du", "-sm", RELAY_DIR]);
      const duText = await new Response(duProc.stdout).text();
      await duProc.exited;
      relayDirMB = parseInt(duText.split("\t")[0] || "0");
    } catch {
      // du might fail if directory doesn't exist
    }

    return { totalGB, usedGB, availableGB, usedPercent, relayDirMB };
  } catch (error) {
    console.error("Disk usage check failed:", error);
    return { totalGB: 0, usedGB: 0, availableGB: 0, usedPercent: 0, relayDirMB: 0 };
  }
}

/**
 * Get system process count for health monitoring.
 * Counts total processes, running state, and claude/bun specific processes.
 */
async function getProcessCount(): Promise<{
  total: number;
  running: number;
  claudeProcesses: number;
  bunProcesses: number;
}> {
  try {
    // Use ps to get process stats
    const psProc = spawn(["ps", "aux", "--no-headers"]);
    const psText = await new Response(psProc.stdout).text();
    await psProc.exited;

    const lines = psText.trim().split("\n").filter(l => l.length > 0);
    const total = lines.length;

    // Count running processes (state R)
    const running = lines.filter(l => /\s+R\s+/.test(l)).length;

    // Count claude processes
    const claudeProcesses = lines.filter(l => /claude/.test(l)).length;

    // Count bun processes
    const bunProcesses = lines.filter(l => /\bbun\b/.test(l)).length;

    return { total, running, claudeProcesses, bunProcesses };
  } catch (error) {
    console.error("Process count check failed:", error);
    return { total: 0, running: 0, claudeProcesses: 0, bunProcesses: 0 };
  }
}

/**
 * Run goal hygiene during heartbeat - auto-archive orphan actions older than threshold.
 * This keeps the memory table clean and prevents stale actions from accumulating.
 * Falls back to direct TypeScript implementation when RPC is not available.
 */
async function runGoalHygiene(daysThreshold: number): Promise<{
  orphansArchived: number;
  malformedDeleted: number;
  hygieneReport: Record<string, unknown> | null;
}> {
  try {
    // Try RPC first
    const { data: hygieneData, error: hygieneError } = await supabase.rpc("goal_hygiene", {
      p_days_stale: daysThreshold,
      p_similarity_threshold: 0.8,
    });

    if (!hygieneError && hygieneData) {
      // RPC available - use it
      const report = hygieneData as Record<string, unknown>;
      const orphanActions = (report?.orphan_actions as Array<{ id: string }>) || [];

      let orphansArchived = 0;
      if (orphanActions.length > 0) {
        const { error: archiveError } = await supabase.rpc("archive_stale_items", {
          p_days_stale: daysThreshold,
          p_dry_run: false,
        });

        if (archiveError) {
          console.log("Goal hygiene: failed to archive stale items:", archiveError.message);
        } else {
          orphansArchived = orphanActions.length;
          console.log(`Goal hygiene: archived ${orphansArchived} orphan action(s)`);
        }
      }

      let malformedDeleted = 0;
      const malformed = (report?.malformed as Array<{ id: string }>) || [];
      if (malformed.length > 0) {
        const { error: deleteError } = await supabase.rpc("delete_malformed_entries", {
          p_dry_run: false,
        });

        if (deleteError) {
          console.log("Goal hygiene: failed to delete malformed:", deleteError.message);
        } else {
          malformedDeleted = malformed.length;
          console.log(`Goal hygiene: deleted ${malformedDeleted} malformed entr(y/ies)`);
        }
      }

      return { orphansArchived, malformedDeleted, hygieneReport: report };
    }

    // Fallback: Direct TypeScript implementation when RPC unavailable
    console.log("Goal hygiene: RPC not available, using direct implementation");

    // Find orphan actions older than threshold (actions with no parent goal)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysThreshold);

    const { data: orphanActions, error: orphanError } = await supabase
      .from("global_memory")
      .select("id, content, priority, created_at")
      .eq("type", "action")
      .eq("status", "pending")
      .is("parent_id", null)
      .lt("created_at", cutoffDate.toISOString());

    let orphansArchived = 0;
    if (!orphanError && orphanActions && orphanActions.length > 0) {
      const orphanIds = orphanActions.map((a) => a.id);
      const { error: archiveError } = await supabase
        .from("global_memory")
        .update({ type: "completed_action" })
        .in("id", orphanIds);

      if (archiveError) {
        console.log("Goal hygiene: failed to archive orphan actions:", archiveError.message);
      } else {
        orphansArchived = orphanIds.length;
        console.log(`Goal hygiene: archived ${orphansArchived} orphan action(s)`);
      }
    }

    // Find and delete malformed entries
    const { data: malformed, error: malformedQueryError } = await supabase
      .from("global_memory")
      .select("id, content, type")
      .or("content.is.null,content.eq.")
      .or("content.like.]`%,content.like.%`[%", { foreignTable: "global_memory" });

    let malformedDeleted = 0;
    if (!malformedQueryError && malformed && malformed.length > 0) {
      const malformedIds = malformed.map((m) => m.id);
      const { error: deleteError } = await supabase.from("global_memory").delete().in("id", malformedIds);

      if (deleteError) {
        console.log("Goal hygiene: failed to delete malformed entries:", deleteError.message);
      } else {
        malformedDeleted = malformedIds.length;
        console.log(`Goal hygiene: deleted ${malformedDeleted} malformed entr(y/ies)`);
      }
    }

    // Build hygiene report for logging
    const { count: totalGoals } = await supabase
      .from("global_memory")
      .select("*", { count: "exact", head: true })
      .eq("type", "goal")
      .eq("status", "active");

    const { count: totalActions } = await supabase
      .from("global_memory")
      .select("*", { count: "exact", head: true })
      .eq("type", "action")
      .eq("status", "pending");

    const report = {
      summary: {
        total_active_goals: totalGoals || 0,
        total_pending_actions: totalActions || 0,
      },
      orphan_actions: orphanActions || [],
      malformed: malformed || [],
      fallback_mode: true,
    };

    return { orphansArchived, malformedDeleted, hygieneReport: report };
  } catch (error) {
    console.error("Goal hygiene error:", error);
    return { orphansArchived: 0, malformedDeleted: 0, hygieneReport: null };
  }
}

async function heartbeatTick(): Promise<void> {
  if (heartbeatRunning) {
    console.log("Heartbeat: skipping (previous tick still running)");
    return;
  }

  heartbeatRunning = true;
  try {
    const config = await getHeartbeatConfig();
    if (!config || !config.enabled) {
      console.log("Heartbeat: disabled or no config");
      return;
    }

    // Check active hours before proceeding
    if (!isWithinActiveHours(config)) {
      console.log(`Heartbeat: outside active hours (${config.active_hours_start}-${config.active_hours_end} ${config.timezone})`);
      await logEventV2("heartbeat_skip", "Outside active hours", {
        active_hours_start: config.active_hours_start,
        active_hours_end: config.active_hours_end,
        timezone: config.timezone,
      });
      return;
    }

    console.log("Heartbeat: tick");
    await logEventV2("heartbeat_tick", "Heartbeat timer fired", {
      interval_minutes: config.interval_minutes,
    });

    // Step 0: Clean up orphaned files from crashes/errors
    await cleanupOrphanedFiles();

    // Step 0.1: Cleanup stale rate limit entries (prevents memory leak)
    const removedRateLimits = cleanupRateLimitMap();
    if (removedRateLimits > 0) {
      console.log(`Heartbeat: cleaned up ${removedRateLimits} stale rate limit entries`);
    }

    // Step 0.5: Check disk usage (log weekly or when >80%)
    const diskUsage = await checkDiskUsage();
    const shouldLogDisk = diskUsage.usedPercent >= 80 || (new Date().getDay() === 0); // Sunday or high usage
    if (shouldLogDisk) {
      await logEventV2("disk_usage", "Disk usage check", {
        total_gb: diskUsage.totalGB,
        used_gb: diskUsage.usedGB,
        available_gb: diskUsage.availableGB,
        used_percent: diskUsage.usedPercent,
        relay_dir_mb: diskUsage.relayDirMB,
      });
      if (diskUsage.usedPercent >= 80) {
        console.log(`Heartbeat: disk usage at ${diskUsage.usedPercent}% (${diskUsage.usedGB}G/${diskUsage.totalGB}G)`);
      }
    }

    // Step 0.6: Check Supabase connectivity (log on failure)
    try {
      const { error: healthError } = await supabase.from("threads").select("id").limit(1);
      if (healthError) {
        await logEventV2("supabase_health", "Supabase health check failed", {
          error: healthError.message,
        });
        console.log(`Heartbeat: Supabase health check failed: ${healthError.message}`);
      }
    } catch (e) {
      await logEventV2("supabase_health", "Supabase connection error", {
        error: String(e),
      });
      console.log(`Heartbeat: Supabase connection error: ${e}`);
    }

    // Step 0.65: Log circuit breaker stats (log if any open or on Sunday for full stats)
    const breakerStats = circuitBreakers.getAllStats();
    const hasOpenCircuits = breakerStats.some(s => s.state === 'open');
    const shouldLogBreakers = hasOpenCircuits || new Date().getDay() === 0;
    if (shouldLogBreakers) {
      await logEventV2("circuit_breakers", "Circuit breaker health check", {
        breakers: breakerStats.map(s => ({
          name: s.name,
          state: s.state,
          total_calls: s.totalCalls,
          total_failures: s.totalFailures,
          last_failure: s.lastFailure?.toISOString(),
        })),
        has_open: hasOpenCircuits,
      });
      if (hasOpenCircuits) {
        const openCircuits = breakerStats.filter(s => s.state === 'open').map(s => s.name);
        console.log(`Heartbeat: open circuits: ${openCircuits.join(', ')}`);
      }
    }

    // Step 0.68: Log process count for system health monitoring
    const processCount = await getProcessCount();
    const shouldLogProcesses = processCount.total > 150 || new Date().getDay() === 0;
    if (shouldLogProcesses) {
      await logEventV2("process_count", "System process count", {
        total: processCount.total,
        running: processCount.running,
        claude_processes: processCount.claudeProcesses,
        bun_processes: processCount.bunProcesses,
      });
      if (processCount.total > 150) {
        console.log(`Heartbeat: high process count: ${processCount.total} total`);
      }
    }

    // Step 0.7: Run goal hygiene - auto-archive orphan actions older than 7 days
    // Run weekly (Sunday) or when there are known issues
    const shouldRunHygiene = new Date().getDay() === 0; // Sunday
    if (shouldRunHygiene) {
      const hygieneResult = await runGoalHygiene(7);
      if (hygieneResult.orphansArchived > 0 || hygieneResult.malformedDeleted > 0) {
        await logEventV2("goal_hygiene", "Auto-archived orphan actions", {
          orphans_archived: hygieneResult.orphansArchived,
          malformed_deleted: hygieneResult.malformedDeleted,
        });
      }
    }

    // Step 1: Read HEARTBEAT.md checklist
    const checklist = await readHeartbeatChecklist();
    if (!checklist) {
      console.log("Heartbeat: no HEARTBEAT.md found, skipping");
      await logEventV2("heartbeat_skip", "No HEARTBEAT.md file found");
      return;
    }

    // Step 1.5: Sync cron jobs defined in HEARTBEAT.md
    await syncCronJobsFromFile(checklist);

    // Step 2: Build prompt and call Claude (standalone, no --resume)
    const prompt = await buildHeartbeatPrompt(checklist);
    const { text: rawResponse } = await callClaude(prompt);

    if (!rawResponse || rawResponse.startsWith("Error:")) {
      console.error("Heartbeat: Claude call failed:", rawResponse);
      await logEventV2("heartbeat_error", rawResponse?.substring(0, 200) || "Empty response");
      return;
    }

    // Step 3: Check for HEARTBEAT_OK — nothing to report
    if (rawResponse.trim() === "HEARTBEAT_OK" || rawResponse.includes("HEARTBEAT_OK")) {
      console.log("Heartbeat: HEARTBEAT_OK — nothing to report");
      await logEventV2("heartbeat_ok", "Claude reported nothing noteworthy");
      return;
    }

    // Step 4: Process intents ([REMEMBER:], [FORGET:], [GOAL:], [DONE:])
    const cleanResponse = await processIntents(rawResponse);

    // Strip [VOICE_REPLY] tag if Claude included it despite instructions
    const finalMessage = cleanResponse.replace(/\[VOICE_REPLY\]/gi, "").trim();

    if (!finalMessage) {
      console.log("Heartbeat: empty after processing intents");
      return;
    }

    // Step 5: Check deduplication — suppress identical messages within 24h
    const isDuplicate = await isHeartbeatDuplicate(finalMessage);
    if (isDuplicate) {
      console.log("Heartbeat: duplicate message suppressed (seen in last 24h)");
      await logEventV2("heartbeat_dedup", "Duplicate message suppressed", {
        message_preview: finalMessage.substring(0, 100),
      });
      return;
    }

    // Step 6: Deliver to Telegram
    await sendHeartbeatToTelegram(finalMessage);
    console.log(`Heartbeat: delivered (${finalMessage.length} chars)`);
    await logEventV2("heartbeat_delivered", "Heartbeat message sent to user", {
      message_text: finalMessage.trim(),
      message_length: finalMessage.length,
    });
  } catch (e) {
    console.error("Heartbeat tick error:", e);
    await logEventV2("heartbeat_error", String(e).substring(0, 200));
  } finally {
    heartbeatRunning = false;
  }
}

function startHeartbeat(intervalMinutes: number): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  heartbeatTimer = setInterval(heartbeatTick, intervalMs);
  console.log(`Heartbeat: started (every ${intervalMinutes} min)`);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log("Heartbeat: stopped");
  }
}

// Guard: prevent overlapping heartbeat calls
let heartbeatRunning = false;

// Cache for heartbeat topic thread ID (persisted in Supabase threads table)
let heartbeatTopicId: number | null = null;

async function readHeartbeatChecklist(): Promise<string> {
  if (!PROJECT_DIR) return "";
  try {
    const heartbeatPath = join(PROJECT_DIR, "HEARTBEAT.md");
    return await readFile(heartbeatPath, "utf-8");
  } catch {
    return "";
  }
}

function parseCronJobsFromChecklist(
  checklist: string
): Array<{ schedule: string; scheduleType: 'cron' | 'interval' | 'once'; prompt: string }> {
  const results: Array<{ schedule: string; scheduleType: 'cron' | 'interval' | 'once'; prompt: string }> = [];

  // Find the ## Cron Jobs or ## Cron section
  const sectionMatch = checklist.match(/^##\s+Cron(?:\s+Jobs)?\s*\n([\s\S]*?)(?=\n##\s|\n---|$)/mi);
  if (!sectionMatch) return results;

  const section = sectionMatch[1];
  const lines = section.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;

    // Parse: - "schedule" prompt
    const match = trimmed.match(/^-\s+"([^"]+)"\s+(.+)$/);
    if (!match) continue;

    const schedule = match[1].trim();
    const prompt = match[2].trim();

    const scheduleType = detectScheduleType(schedule);
    if (!scheduleType) continue;

    results.push({ schedule, scheduleType, prompt });
  }

  return results;
}

async function syncCronJobsFromFile(checklist: string): Promise<void> {
  if (!supabase) return;

  const definitions = parseCronJobsFromChecklist(checklist);
  if (definitions.length === 0) return;

  try {
    // Get existing file-sourced jobs
    const { data: existingJobs } = await supabase
      .from("cron_jobs")
      .select("*")
      .eq("source", "file");

    const existing = (existingJobs || []) as CronJob[];

    // Track which existing jobs are still in the file
    const matchedIds = new Set<string>();

    for (const def of definitions) {
      // Find existing job by prompt (exact match)
      const match = existing.find(j => j.prompt === def.prompt);

      if (match) {
        matchedIds.add(match.id);

        // Update schedule if changed
        if (match.schedule !== def.schedule || match.schedule_type !== def.scheduleType || !match.enabled) {
          const updatedJob = { ...match, schedule: def.schedule, schedule_type: def.scheduleType };
          const nextRun = computeNextRun(updatedJob as CronJob);
          await supabase
            .from("cron_jobs")
            .update({
              schedule: def.schedule,
              schedule_type: def.scheduleType,
              enabled: true,
              next_run_at: nextRun,
              updated_at: new Date().toISOString(),
            })
            .eq("id", match.id);
          console.log(`[Cron] File sync: updated job "${match.name}" schedule to ${def.schedule}`);
        }
      } else {
        // Create new job
        const name = def.prompt.length <= 50 ? def.prompt : def.prompt.substring(0, 47) + "...";
        const job = await createCronJob(name, def.schedule, def.scheduleType, def.prompt, undefined, "file");
        if (job) {
          console.log(`[Cron] File sync: created job "${name}" (${def.schedule})`);
        }
      }
    }

    // Disable file-sourced jobs that are no longer in the file
    for (const job of existing) {
      if (!matchedIds.has(job.id) && job.enabled) {
        await disableCronJob(job.id);
        console.log(`[Cron] File sync: disabled removed job "${job.name}"`);
      }
    }
  } catch (e) {
    console.error("[Cron] File sync error:", e);
  }
}

function isWithinActiveHours(config: HeartbeatConfig): boolean {
  const tz = config.timezone || "America/Sao_Paulo";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = (config.active_hours_start || "08:00").split(":").map(Number);
  const [endH, endM] = (config.active_hours_end || "22:00").split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range (e.g., 22:00-06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

async function getOrCreateHeartbeatTopic(): Promise<{ chatId: number; threadId: number } | null> {
  if (!TELEGRAM_GROUP_ID) return null;

  const chatId = parseInt(TELEGRAM_GROUP_ID);
  if (isNaN(chatId)) return null;

  // Return cached value
  if (heartbeatTopicId) return { chatId, threadId: heartbeatTopicId };

  // Check Supabase for existing heartbeat thread
  if (supabase) {
    try {
      const { data } = await supabase
        .from("threads")
        .select("telegram_thread_id")
        .eq("telegram_chat_id", chatId)
        .eq("title", "Heartbeat")
        .not("telegram_thread_id", "is", null)
        .limit(1)
        .single();

      if (data?.telegram_thread_id) {
        heartbeatTopicId = data.telegram_thread_id;
        return { chatId, threadId: heartbeatTopicId };
      }
    } catch {
      // No existing thread found — will create one
    }
  }

  // Create new forum topic
  try {
    const topic = await bot.api.createForumTopic(chatId, "Heartbeat");
    heartbeatTopicId = topic.message_thread_id;

    // Persist in Supabase threads table
    await getOrCreateThread(chatId, heartbeatTopicId, "Heartbeat");

    console.log(`Heartbeat: created forum topic (thread_id: ${heartbeatTopicId})`);
    return { chatId, threadId: heartbeatTopicId };
  } catch (e) {
    console.error("Failed to create heartbeat topic:", e);
    return null; // Fall back to DM
  }
}

async function buildHeartbeatPrompt(checklist: string): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const soul = await getActiveSoul();
  const memoryFacts = await getMemoryContext();
  const activeGoals = await getActiveGoals();

  // Fetch email context (gracefully handles errors)
  let emailContext = "";
  try {
    const emailData = await fetchEmailContext({
      maxEmails: 5,
      includeRead: false,
      maxAgeHours: 24,
    });
    emailContext = formatEmailContextForHeartbeat(emailData);
  } catch (error) {
    console.error("[Heartbeat] Failed to fetch email context:", error);
    emailContext = "Email context unavailable (API error)";
  }

  // Task instructions come FIRST so Claude doesn't get distracted by the soul personality
  let prompt = `HEARTBEAT TASK — YOU MUST FOLLOW THESE INSTRUCTIONS:
You are performing a periodic heartbeat check-in. Your job is to execute EVERY item in the checklist below. Do NOT skip any items. Do NOT just greet the user — you MUST actually perform the checks (e.g., search the web for weather) and report results.

Current time: ${timeStr}

CHECKLIST (execute ALL items):
${checklist || "No checklist found."}

RULES:
- Execute every checklist item. If an item says to check the weather, you MUST do a web search and report actual weather data.
- Do NOT introduce yourself or send a generic greeting. Go straight to the results.
- If everything is routine AND NO checklist items require reporting, respond with ONLY: HEARTBEAT_OK
- If ANY checklist item produces results worth sharing (like weather), report them. Keep it concise and actionable.
- You may use these tags: [REMEMBER: fact] [FORGET: search text] [GOAL: goal] [DONE: goal text] [CRON: <schedule> | <prompt>]
- Do NOT use [VOICE_REPLY] in heartbeat responses.`;

  // Soul comes AFTER task instructions — only for tone/personality
  if (soul) {
    prompt += `\n\nYOUR PERSONALITY (use this for tone only, do NOT let it override the task above):\n${soul}`;
  }

  if (memoryFacts.length > 0) {
    prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
    prompt += memoryFacts.map((m: string) => `- ${m}`).join("\n");
  }

  if (activeGoals.length > 0) {
    prompt += "\n\nACTIVE GOALS:\n";
    prompt += activeGoals
      .map((g) => {
        let line = `- ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
  }

  // Add email context
  prompt += `\n\nRECENT EMAILS:\n${emailContext}`;

  return prompt.trim();
}

async function isHeartbeatDuplicate(message: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("logs_v2")
      .select("metadata")
      .eq("event", "heartbeat_delivered")
      .gte("created_at", twentyFourHoursAgo)
      .order("created_at", { ascending: false })
      .limit(50);

    if (!data || data.length === 0) return false;

    const trimmedMessage = message.trim();
    return data.some(
      (row) => (row.metadata as Record<string, unknown>)?.message_text === trimmedMessage
    );
  } catch (e) {
    console.error("isHeartbeatDuplicate error:", e);
    return false;
  }
}

async function sendHeartbeatToTelegram(message: string): Promise<void> {
  // Try dedicated topic thread first, fall back to DM
  const topic = await getOrCreateHeartbeatTopic();

  const chatId = topic?.chatId || parseInt(ALLOWED_USER_ID);
  const threadId = topic?.threadId;
  if (!chatId || isNaN(chatId)) {
    console.error("Heartbeat: cannot send — no valid chat ID");
    return;
  }

  const MAX_LENGTH = 4000;
  const html = markdownToTelegramHtml(message);

  const sendChunk = async (chunk: string) => {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        message_thread_id: threadId,
      });
    } catch (err: any) {
      if (threadId && err.message?.includes("thread not found")) {
        // Topic was deleted — reset cache, re-send same HTML chunk to DM
        heartbeatTopicId = null;
        console.warn("Heartbeat topic was deleted, falling back to DM");
        try {
          await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), chunk, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), chunk.replace(/<[^>]+>/g, ""));
        }
        return;
      }
      // HTML parse failure — send as plain text (strip tags from HTML chunk)
      console.warn("Heartbeat HTML parse failed, falling back to plain text:", err.message);
      await bot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""), {
        message_thread_id: threadId,
      });
    }
  };

  if (html.length <= MAX_LENGTH) {
    await sendChunk(html);
    return;
  }

  // Chunk long messages
  let remaining = html;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      await sendChunk(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;
    await sendChunk(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }
}

async function processIntents(response: string, threadDbId?: string): Promise<string> {
  let clean = response;
  const failures: string[] = [];

  // Log if any intent tags are detected at all
  const hasIntents = /\[(REMEMBER|FORGET|GOAL|DONE|CRON|VOICE_REPLY)[:\]]/i.test(response);
  if (hasIntents) {
    console.log(`[Intents] Detected intent tags in response (${response.length} chars)`);
  }

  // [REMEMBER: concise fact about the user]
  const rememberMatches = response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi);
  for (const match of rememberMatches) {
    const fact = match[1].trim();
    // Security: cap fact length to prevent memory abuse
    if (fact.length > 0 && fact.length <= 200) {
      const ok = await insertMemory(fact, "fact", threadDbId);
      if (ok) {
        console.log(`Remembered: ${fact}`);
      } else {
        console.warn(`[Intents] REMEMBER failed to insert: ${fact}`);
        failures.push(`Failed to save: "${fact}"`);
      }
    } else {
      console.warn(`Rejected REMEMBER fact: too long (${fact.length} chars)`);
      failures.push(`Rejected fact (too long): "${fact.substring(0, 50)}..."`);
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  const goalMatches = response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  );
  for (const match of goalMatches) {
    const goalText = match[1].trim();
    const deadline = match[2]?.trim() || null;
    if (goalText.length > 0 && goalText.length <= 200) {
      const ok = await insertMemory(goalText, "goal", threadDbId, deadline);
      if (ok) {
        console.log(
          `Goal set: ${goalText}${deadline ? ` (deadline: ${deadline})` : ""}`
        );
      } else {
        console.warn(`[Intents] GOAL failed to insert: ${goalText}`);
        failures.push(`Failed to save goal: "${goalText}"`);
      }
    } else if (goalText.length > 200) {
      console.warn(`Rejected GOAL: too long (${goalText.length} chars)`);
    }
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text to mark a goal as completed]
  const doneMatches = response.matchAll(/\[DONE:\s*(.+?)\]/gi);
  for (const match of doneMatches) {
    const searchText = match[1].trim();
    if (searchText.length > 0 && searchText.length <= 200) {
      const completed = await completeGoal(searchText);
      if (completed) {
        console.log(`Goal completed matching: ${searchText}`);
      } else {
        console.warn(`[Intents] DONE failed: no active goal matching "${searchText}"`);
        failures.push(`No active goal found matching: "${searchText}"`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  // [FORGET: search text to remove a fact]
  const forgetMatches = response.matchAll(/\[FORGET:\s*(.+?)\]/gi);
  for (const match of forgetMatches) {
    const searchText = match[1].trim();
    const deleted = await deleteMemory(searchText);
    if (deleted) {
      console.log(`Forgot memory matching: ${searchText}`);
    } else {
      console.warn(`[Intents] FORGET failed: no match for "${searchText}"`);
      failures.push(`Could not find memory matching: "${searchText}"`);
    }
    clean = clean.replace(match[0], "");
  }

  // [CRON: schedule | prompt] — agent self-scheduling
  const cronMatches = response.matchAll(/\[CRON:\s*(.+?)\s*\|\s*(.+?)\]/gi);
  for (const match of cronMatches) {
    const schedule = match[1].trim();
    const prompt = match[2].trim();

    if (schedule.length > 0 && prompt.length > 0 && prompt.length <= 500) {
      const scheduleType = detectScheduleType(schedule);
      if (scheduleType) {
        const name = prompt.length <= 50 ? prompt : prompt.substring(0, 47) + "...";
        const job = await createCronJob(name, schedule, scheduleType, prompt, threadDbId || undefined, "agent");
        if (job) {
          console.log(`[Agent] Created cron job: "${name}" (${schedule})`);
          await logEventV2("cron_created", `Agent created cron job: ${name}`, {
            job_id: job.id,
            schedule,
            schedule_type: scheduleType,
            prompt: prompt.substring(0, 100),
            source: "agent",
          }, threadDbId);
        }
      } else {
        console.warn(`[Agent] Invalid schedule in CRON intent: "${schedule}"`);
      }
    } else {
      console.warn(`[Agent] Rejected CRON intent: schedule="${schedule}" prompt length=${prompt.length}`);
    }
    clean = clean.replace(match[0], "");
  }

  // Append failure notice so the user knows when memory ops silently failed
  if (failures.length > 0) {
    console.warn(`[Intents] ${failures.length} operation(s) failed:`, failures);
    clean += `\n\n[Memory ops failed: ${failures.join("; ")}]`;
  }

  return clean.trim();
}

// ============================================================
// VOICE TRANSCRIPTION (Groq Whisper API)
// ============================================================

async function transcribeAudio(audioPath: string): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set — cannot transcribe audio");
  }

  // Convert .oga to .wav for Whisper API (smaller + more compatible)
  const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");

  const ffmpeg = spawn(
    [
      FFMPEG_PATH,
      "-i",
      audioPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
      "-y",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  await ffmpeg.exited;

  // Send to Groq Whisper API (with circuit breaker protection)
  const audioBuffer = await readFile(wavPath);
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
  formData.append("model", GROQ_WHISPER_MODEL);
  // No language param — let Whisper auto-detect for correct multilingual support

  try {
    const response = await groqCircuitBreaker.execute(async () => {
      return await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: formData,
      });
    });

    // Cleanup wav immediately
    await unlink(wavPath).catch(() => {});

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Groq Whisper error ${response.status}: ${errText}`);
      // Log rate limit events for observability
      if (response.status === 429) {
        logEventV2("rate_limit", "Groq Whisper rate limited", {
          service: "groq",
          endpoint: "transcriptions",
          model: GROQ_WHISPER_MODEL,
          status: 429,
          response: errText.substring(0, 500),
        }).catch(() => {});
      }
      throw new Error(`Transcription failed: ${response.status}`);
    }

    const result = await response.json() as { text: string };
    return result.text.trim();
  } catch (error) {
    // Cleanup wav on error too
    await unlink(wavPath).catch(() => {});
    if (error instanceof CircuitOpenError) {
      throw new Error(`Voice transcription temporarily unavailable (Groq API circuit open). Please try again in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`);
    }
    throw error;
  }
}

// ============================================================
// TEXT-TO-SPEECH (ElevenLabs v3)
// ============================================================

const TTS_MAX_CHARS = 4500;

async function textToSpeechEdge(text: string): Promise<Buffer | null> {
  try {
    const ttsText = text.length > TTS_MAX_CHARS
      ? text.substring(0, TTS_MAX_CHARS) + "..."
      : text;

    // Create temp file for output
    const tempFile = join(RELAY_DIR, "temp", `tts-${Date.now()}.mp3`);
    await mkdir(dirname(tempFile), { recursive: true });

    // Run edge-tts
    const proc = spawn({
      cmd: [
        EDGE_TTS_PATH,
        "--voice", EDGE_TTS_VOICE,
        "--rate", `+${Math.round((parseFloat(EDGE_TTS_SPEED) - 1) * 100)}%`,
        "--text", ttsText,
        "--write-media", tempFile,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`Edge TTS error: ${stderr}`);
      return null;
    }

    // Read the generated file
    const audioBuffer = await readFile(tempFile);

    // Cleanup
    await unlink(tempFile).catch(() => {});

    return audioBuffer;
  } catch (error) {
    console.error("Edge TTS error:", error);
    return null;
  }
}

async function textToSpeechElevenLabs(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;

  // Check if circuit is open before attempting
  if (elevenLabsCircuitBreaker.isOpen()) {
    console.log("[TTS] ElevenLabs circuit is open, falling back to Edge TTS");
    return null;
  }

  try {
    const ttsText = text.length > TTS_MAX_CHARS
      ? text.substring(0, TTS_MAX_CHARS) + "..."
      : text;

    const response = await elevenLabsCircuitBreaker.execute(async () => {
      return await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=opus_48000_64`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": ELEVENLABS_API_KEY,
          },
          body: JSON.stringify({
            text: ttsText,
            model_id: "eleven_v3",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
        }
      );
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`ElevenLabs error ${response.status}: ${errText}`);
      // Log rate limit events for observability
      if (response.status === 429) {
        logEventV2("rate_limit", "ElevenLabs TTS rate limited", {
          service: "elevenlabs",
          endpoint: "text-to-speech",
          voice_id: ELEVENLABS_VOICE_ID,
          status: 429,
          response: errText.substring(0, 500),
        }).catch(() => {});
      }
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      console.log(`[TTS] ElevenLabs circuit open, falling back to Edge TTS`);
      return null;
    }
    console.error("ElevenLabs TTS error:", error);
    return null;
  }
}

async function textToSpeech(text: string): Promise<Buffer | null> {
  console.log(`[TTS] Provider: ${TTS_PROVIDER}, ElevenLabs key: ${ELEVENLABS_API_KEY ? 'yes' : 'no'}`);

  if (TTS_PROVIDER === "edge") {
    console.log("[TTS] Using Edge TTS");
    return textToSpeechEdge(text);
  } else if (TTS_PROVIDER === "elevenlabs" && ELEVENLABS_API_KEY) {
    console.log("[TTS] Using ElevenLabs");
    return textToSpeechElevenLabs(text);
  }
  // Fallback to Edge TTS (free)
  console.log("[TTS] Falling back to Edge TTS");
  return textToSpeechEdge(text);
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock.trim());
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.log(`Another instance running (PID: ${pid})`);
          return false;
        } catch {
          console.log("Stale lock found, taking over...");
          // Remove stale lock before attempting to create new one
          await unlink(LOCK_FILE).catch(() => {});
        }
      }
    }

    // Use exclusive flag to prevent race conditions between instances
    const fd = await open(LOCK_FILE, "wx").catch(() => null);
    if (fd) {
      await fd.writeFile(process.pid.toString());
      await fd.close();
      return true;
    }

    // File was created between our check and open - another instance won
    // Verify who actually got it
    const newLock = await readFile(LOCK_FILE, "utf-8").catch(() => "");
    const newPid = parseInt(newLock.trim());
    if (!isNaN(newPid) && newPid !== process.pid) {
      try {
        process.kill(newPid, 0);
        console.log(`Another instance won race (PID: ${newPid})`);
        return false;
      } catch {
        // Weird - they died right after acquiring lock, retry
        await unlink(LOCK_FILE).catch(() => {});
        return acquireLock(); // Recursive retry
      }
    }

    // We somehow have the lock (race condition edge case)
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  stopHeartbeat();
  stopCronScheduler();
  stopTokenRefreshScheduler();
  await logEventV2("bot_stopping", "Relay shutting down (SIGINT)");
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  stopHeartbeat();
  stopCronScheduler();
  stopTokenRefreshScheduler();
  await logEventV2("bot_stopping", "Relay shutting down (SIGTERM)");
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  process.exit(1);
}

if (!ALLOWED_USER_ID) {
  console.error("TELEGRAM_USER_ID not set! Refusing to start without auth gate.");
  process.exit(1);
}

await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Build skill registry once at startup
skillRegistry = await buildSkillRegistry();
console.log(`Skill registry: ${skillRegistry ? skillRegistry.split("\n").length - 1 + " skills loaded" : "none found"}`);

if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot<CustomContext>(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (!userId || userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId || "unknown"}`);
    return; // Silent reject — don't reveal bot existence to strangers
  }
  if (isRateLimited(userId)) {
    await ctx.reply("Calma aí! Muitas mensagens seguidas. Tenta de novo em um minuto.");
    return;
  }
  await next();
});

// ============================================================
// THREAD ROUTING MIDDLEWARE
// ============================================================

bot.use(async (ctx, next) => {
  if (!ctx.message && !ctx.callbackQuery) {
    await next();
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await next();
    return;
  }

  const chatType = ctx.chat?.type;
  const telegramThreadId = ctx.message?.message_thread_id ?? null;

  // Determine title and thread ID based on chat context
  let title: string;
  let threadId: number | null = telegramThreadId;

  if (chatType === "private") {
    // DM: no thread ID, titled "DM"
    title = "DM";
  } else if (telegramThreadId != null && ctx.message?.is_topic_message) {
    // Group with Topics: specific topic
    title = `Topic ${telegramThreadId}`;
  } else if ((chatType === "group" || chatType === "supergroup") && telegramThreadId === null) {
    // Group without Topics, OR the "General" topic in a group with Topics
    title = "Group Chat";
    threadId = null;
  } else {
    // Fallback
    title = "DM";
  }

  const thread = await getOrCreateThread(chatId, threadId, title);

  if (thread) {
    ctx.threadInfo = {
      dbId: thread.id,
      chatId: thread.telegram_chat_id,
      threadId: thread.telegram_thread_id,
      title: thread.title || title,
      sessionId: thread.claude_session_id,
      summary: thread.summary || "",
      messageCount: thread.message_count || 0,
    };
  }

  await next();
});

// ============================================================
// LIVENESS & PROGRESS INDICATORS
// ============================================================

const TYPING_INTERVAL_MS = 4_000; // Send typing action every 4s (expires after ~5s)
const PROGRESS_THROTTLE_MS = 15_000; // Max 1 progress message per 15s

// Map Claude CLI tool names to user-friendly descriptions
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Bash: "Running command",
  Glob: "Searching files",
  Grep: "Searching code",
  WebSearch: "Searching the web",
  WebFetch: "Fetching web page",
  Task: "Running sub-agent",
  NotebookEdit: "Editing notebook",
  EnterPlanMode: "Planning",
  AskUserQuestion: "Asking question",
};

function formatToolName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name;
}

interface LivenessReporter {
  onStreamEvent: (event: any) => void;
  cleanup: () => Promise<void>;
}

function createLivenessReporter(
  chatId: number,
  messageThreadId?: number
): LivenessReporter {
  // LIVE-01: Continuous typing indicator
  const typingInterval = setInterval(() => {
    bot.api
      .sendChatAction(chatId, "typing", {
        message_thread_id: messageThreadId,
      })
      .catch(() => {}); // Silently ignore errors (chat may be unavailable)
  }, TYPING_INTERVAL_MS);

  // PROG-01 + PROG-02: Throttled progress messages
  let statusMessageId: number | null = null;
  let lastProgressAt = 0;
  let lastProgressText = "";
  let pendingTools: string[] = [];
  let sendingProgress = false; // Guard against overlapping sends

  const sendOrUpdateProgress = async (toolNames: string[]) => {
    if (sendingProgress) {
      console.log(`[Liveness] Skipped (already sending): ${toolNames.join(", ")}`);
      pendingTools.push(...toolNames);
      return;
    }

    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS) {
      console.log(`[Liveness] Throttled: ${toolNames.join(", ")}`);
      pendingTools.push(...toolNames);
      return;
    }

    sendingProgress = true;
    const allTools = [...pendingTools, ...toolNames];
    pendingTools = [];
    lastProgressAt = now;

    // Deduplicate tool names while preserving order
    const unique = [...new Set(allTools)];
    const display = unique.map(formatToolName).join(", ");
    const text = `🔄 ${display}...`;

    // Skip if text hasn't changed (avoids "message is not modified" errors)
    if (text === lastProgressText) {
      sendingProgress = false;
      return;
    }
    lastProgressText = text;

    try {
      if (statusMessageId) {
        console.log(`[Liveness] Editing progress: "${text}"`);
        await bot.api.editMessageText(chatId, statusMessageId, text);
      } else {
        console.log(`[Liveness] Sending progress: "${text}" to chat=${chatId} thread=${messageThreadId}`);
        const msg = await bot.api.sendMessage(chatId, text, {
          message_thread_id: messageThreadId,
        });
        statusMessageId = msg.message_id;
        console.log(`[Liveness] Progress message sent: id=${statusMessageId}`);
      }
    } catch (err: any) {
      // Silently ignore "message is not modified" errors
      if (!err.message?.includes("message is not modified")) {
        console.error(`[Liveness] Failed to send/edit progress: ${err.message}`);
      }
    } finally {
      sendingProgress = false;
    }
  };

  const onStreamEvent = (event: any) => {
    // Log all event types for debugging (temporary)
    if (event.type) {
      const contentTypes = event.message?.content?.map((b: any) => b.type)?.join(",") || "none";
      console.log(`[Liveness] Event: type=${event.type} subtype=${event.subtype || "-"} content=[${contentTypes}]`);
    }

    // Detect tool_use blocks in assistant events
    if (event.type === "assistant" && event.message?.content) {
      const toolNames: string[] = [];
      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name) {
          toolNames.push(block.name);
        }
      }
      if (toolNames.length > 0) {
        console.log(`[Liveness] Tool use detected: ${toolNames.join(", ")}`);
        sendOrUpdateProgress(toolNames); // Fire-and-forget (async but not awaited)
      }
    }
  };

  // LIVE-02: Cleanup stops all indicators
  const cleanup = async () => {
    clearInterval(typingInterval);
    if (statusMessageId) {
      try {
        await bot.api.deleteMessage(chatId, statusMessageId);
      } catch {
        // Message already deleted or chat unavailable — ignore
      }
    }
  };

  return { onStreamEvent, cleanup };
}

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  threadInfo?: ThreadInfo,
  onStreamEvent?: (event: any) => void
): Promise<{ text: string; sessionId: string | null }> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume from thread's stored session if available
  if (threadInfo?.sessionId) {
    args.push("--resume", threadInfo.sessionId);
  }

  args.push("--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions");

  console.log(`Calling Claude: ${prompt.substring(0, 80)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: { ...process.env },
    });

    // Inactivity-based timeout: kill only if Claude goes silent for 15 min.
    // With stream-json, every event resets this timer — much more reliable than stderr-only.
    let timedOut = false;
    let inactivityTimer: Timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid!, "SIGTERM");
      } catch {
        proc.kill();
      }
    }, CLAUDE_INACTIVITY_TIMEOUT_MS);

    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      if (timedOut) return;
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid!, "SIGTERM");
        } catch {
          proc.kill();
        }
      }, CLAUDE_INACTIVITY_TIMEOUT_MS);
    };

    // Drain stderr for logging (no longer used for activity detection)
    const stderrChunks: string[] = [];
    const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const stderrDecoder = new TextDecoder();
    const stderrDrain = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrChunks.push(stderrDecoder.decode(value, { stream: true }));
        }
      } catch {
        // Stream closed — process ended
      }
    })();

    // Parse stdout as NDJSON stream (one JSON event per line)
    let resultText = "";
    let newSessionId: string | null = null;
    let buffer = "";
    let totalBytes = 0;
    let lastAssistantText = ""; // Fallback: accumulate text from assistant events
    const eventTypesSeen: string[] = [];
    let jsonParseErrors = 0;
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const stdoutDecoder = new TextDecoder();

    // Helper: extract text from a result event (handles multiple content block formats)
    const extractResultText = (event: any): string | null => {
      if (typeof event.result === "string") return event.result;
      if (Array.isArray(event.result?.content)) {
        // Find the first text block in content array (not necessarily [0])
        for (const block of event.result.content) {
          if (block.type === "text" && block.text) return block.text;
        }
      }
      // Legacy: direct content[0].text without type check
      if (event.result?.content?.[0]?.text) return event.result.content[0].text;
      return null;
    };

    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;

        const chunk = stdoutDecoder.decode(value, { stream: true });
        totalBytes += chunk.length;
        buffer += chunk;

        // Size guard: stop accumulating if output is enormous
        if (totalBytes > MAX_OUTPUT_SIZE) {
          console.warn(`Claude stream output very large (${totalBytes} bytes), stopping parse`);
          break;
        }

        // Split into complete lines, keep last partial line in buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          // Every line of output = activity → reset inactivity timer
          resetInactivityTimer();

          try {
            const event = JSON.parse(line);
            eventTypesSeen.push(event.type || "unknown");

            // Extract session ID from init event (available immediately)
            if (event.type === "system" && event.subtype === "init" && event.session_id) {
              newSessionId = event.session_id;
            }

            // Also capture session_id from assistant or result events as fallback
            if (event.session_id && !newSessionId) {
              newSessionId = event.session_id;
            }

            // Accumulate text from assistant events as fallback
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  lastAssistantText = block.text;
                }
              }
            }

            // Extract final result text from result event (always last)
            if (event.type === "result") {
              const extracted = extractResultText(event);
              if (extracted) {
                resultText = extracted;
              } else {
                console.warn(`[Stream] Result event present but text extraction failed. Keys: ${JSON.stringify(Object.keys(event.result || {}))}`);
              }
              // Result event also has session_id
              if (event.session_id) {
                newSessionId = event.session_id;
              }
            }
            // Fire callback for callers that want real-time event access
            onStreamEvent?.(event);
          } catch {
            jsonParseErrors++;
          }
        }
      }
    } catch {
      // Stream closed — process ended
    }

    // Process any remaining buffer content
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        eventTypesSeen.push(event.type || "unknown");
        if (event.type === "result") {
          const extracted = extractResultText(event);
          if (extracted) resultText = extracted;
          if (event.session_id) newSessionId = event.session_id;
        } else if (event.session_id && !newSessionId) {
          newSessionId = event.session_id;
        }
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              lastAssistantText = block.text;
            }
          }
        }
        resetInactivityTimer();
        onStreamEvent?.(event);
      } catch {
        jsonParseErrors++;
      }
    }

    await stderrDrain;
    clearTimeout(inactivityTimer);
    const stderrText = stderrChunks.join("");
    const exitCode = await proc.exited;

    if (timedOut) {
      console.error("Claude CLI timed out (no activity for 15 minutes)");
      // Clean up any orphaned child processes (skill scripts, auth flows, etc.)
      await killOrphanedProcesses(proc.pid!);
      return { text: "Sorry, Claude appears to be stuck (no activity for 15 minutes). Please try again.", sessionId: null };
    }

    if (exitCode !== 0) {
      // If we used --resume and it failed, retry without it (session may be expired/corrupt)
      if (threadInfo?.sessionId) {
        console.warn(`Session ${threadInfo.sessionId} failed (exit ${exitCode}), starting fresh`);
        return callClaude(prompt, { ...threadInfo, sessionId: null }, onStreamEvent);
      }
      console.error("Claude error:", stderrText);
      return { text: "Sorry, something went wrong processing your request. Please try again.", sessionId: null };
    }

    // Fallback: if no result event was parsed, try assistant text or log diagnostics
    if (!resultText) {
      const evtSummary = eventTypesSeen.length > 0 ? eventTypesSeen.join(", ") : "none";
      console.warn(`[Stream] No result event found. Events: [${evtSummary}], bytes: ${totalBytes}, JSON errors: ${jsonParseErrors}, buffer remainder: ${buffer.substring(0, 200)}`);
      if (lastAssistantText) {
        console.warn(`[Stream] Using fallback text from assistant event (${lastAssistantText.length} chars)`);
        resultText = lastAssistantText;
      } else {
        console.error(`[Stream] No result AND no assistant text. Stream may have been empty or format changed.`);
        resultText = `Something went wrong — Claude finished (exit 0) but produced no parseable text. Events seen: [${evtSummary}], stream bytes: ${totalBytes}. Check relay logs for details.`;
      }
    }

    // Store session ID in Supabase for this thread
    if (newSessionId && threadInfo?.dbId) {
      await updateThreadSession(threadInfo.dbId, newSessionId);
    }

    return { text: resultText.trim(), sessionId: newSessionId };
  } catch (error) {
    console.error("Spawn error:", error);
    return { text: `Error: Could not run Claude CLI`, sessionId: null };
  }
}

// ============================================================
// THREAD SUMMARY AUTO-GENERATION
// ============================================================

async function maybeUpdateThreadSummary(threadInfo: ThreadInfo): Promise<void> {
  if (!threadInfo?.dbId) return;

  // Only update summary every 5 exchanges
  const newCount = await incrementThreadMessageCount(threadInfo.dbId);
  if (newCount === 0 || newCount % 5 !== 0) return;

  try {
    const recentMessages = await getRecentThreadMessages(threadInfo.dbId, 10);
    if (recentMessages.length < 3) return;

    const messagesText = recentMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const summaryPrompt = `Summarize this conversation thread concisely in 2-3 sentences. Focus on the main topics discussed and any decisions or outcomes. Do NOT include any tags like [REMEMBER:] or [FORGET:].

${messagesText}`;

    // Standalone call — no --resume, no thread session
    const { text: summary } = await callClaude(summaryPrompt);
    if (summary && !summary.startsWith("Error:")) {
      await updateThreadSummary(threadInfo.dbId, summary);
      console.log(`Thread summary updated (${threadInfo.dbId}): ${summary.substring(0, 80)}...`);
    }
  } catch (e) {
    console.error("Thread summary generation error:", e);
  }
}

// ============================================================
// COMMANDS
// ============================================================

// /soul command: set bot personality
bot.command("soul", async (ctx) => {
  const text = ctx.match;
  if (!text || text.trim().length === 0) {
    const currentSoul = await getActiveSoul();
    await ctx.reply(`Current soul:\n\n${currentSoul}\n\nUsage: /soul <personality description>`);
    return;
  }

  const success = await setSoul(text.trim());
  if (success) {
    await logEventV2("soul_updated", text.trim().substring(0, 100), {}, ctx.threadInfo?.dbId);
    await ctx.reply(`Soul updated! New personality:\n\n${text.trim()}`);
  } else {
    await ctx.reply("Failed to update soul. Check Supabase connection.");
  }
});

// /new command: reset thread session
bot.command("new", async (ctx) => {
  if (!ctx.threadInfo?.dbId) {
    await ctx.reply("Starting fresh. (No thread context to reset.)");
    return;
  }

  const success = await clearThreadSession(ctx.threadInfo.dbId);
  if (success) {
    ctx.threadInfo.sessionId = null;
    await logEventV2("session_reset", "User started new session", {}, ctx.threadInfo.dbId);
    await ctx.reply("Session reset. Next message starts a fresh conversation.");
  } else {
    await ctx.reply("Could not reset session. Check Supabase connection.");
  }
});

// /memory command: show facts and active goals
bot.command("memory", async (ctx) => {
  const facts = await getMemoryContext();
  const goals = await getActiveGoals();

  if (facts.length === 0 && goals.length === 0) {
    await ctx.reply(
      "No memories stored yet. I'll learn facts about you as we chat."
    );
    return;
  }

  let text = "";

  if (facts.length > 0) {
    text += `Facts (${facts.length}):\n\n`;
    text += facts.map((m, i) => `${i + 1}. ${m}`).join("\n");
  }

  if (goals.length > 0) {
    if (text) text += "\n\n";
    text += `Active Goals (${goals.length}):\n\n`;
    text += goals
      .map((g, i) => {
        let line = `${i + 1}. ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
  }

  text += "\n\nTo remove a memory, ask me to forget it. To complete a goal, tell me it's done.";

  await sendResponse(ctx, text);
});

// /cron command: manage scheduled jobs
bot.command("cron", async (ctx) => {
  const args = (ctx.match || "").trim();

  // /cron list (or just /cron with no args)
  if (!args || args === "list") {
    const allJobs = await getAllCronJobs();
    // Hide disabled one-shot jobs (already executed, just clutter)
    const jobs = allJobs.filter(j => !(j.schedule_type === "once" && !j.enabled));
    if (jobs.length === 0) {
      await ctx.reply("No cron jobs found.\n\nUsage: /cron add \"<schedule>\" <prompt>");
      return;
    }

    let text = `<b>Cron Jobs (${jobs.length})</b>\n\n`;
    jobs.forEach((job, i) => {
      const status = job.enabled ? "✅" : "⏸";
      const nextRun = job.next_run_at
        ? new Date(job.next_run_at).toLocaleString("en-US", {
            timeZone: "America/Sao_Paulo",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—";
      text += `${status} <b>${i + 1}.</b> <code>${job.schedule}</code> (${job.schedule_type})\n`;
      text += `   ${job.prompt.substring(0, 80)}${job.prompt.length > 80 ? "..." : ""}\n`;
      text += `   Next: ${nextRun} · Source: ${job.source}\n\n`;
    });

    text += `Remove: /cron remove <number>\nAdd: /cron add "<schedule>" <prompt>`;

    try {
      await ctx.reply(text, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(text.replace(/<[^>]*>/g, ""));
    }
    return;
  }

  // /cron add "<schedule>" <prompt>
  if (args.startsWith("add ")) {
    const addArgs = args.substring(4).trim();

    // Parse: "schedule" prompt
    const match = addArgs.match(/^"([^"]+)"\s+(.+)$/s);
    if (!match) {
      await ctx.reply(
        'Usage: /cron add "<schedule>" <prompt>\n\n' +
        'Examples:\n' +
        '/cron add "0 7 * * *" morning briefing\n' +
        '/cron add "every 2h" check project status\n' +
        '/cron add "in 20m" remind me to call John'
      );
      return;
    }

    const schedule = match[1].trim();
    const prompt = match[2].trim();

    const scheduleType = detectScheduleType(schedule);
    if (!scheduleType) {
      await ctx.reply(
        `Invalid schedule: "${schedule}"\n\n` +
        "Supported formats:\n" +
        "• Cron: 0 7 * * * (5-field)\n" +
        "• Interval: every 2h, every 30m, every 1h30m\n" +
        "• One-shot: in 20m, in 1h, in 2h30m"
      );
      return;
    }

    // Auto-generate name from prompt (truncate at 50 chars)
    const name = prompt.length <= 50 ? prompt : prompt.substring(0, 47) + "...";

    // Target thread: use current thread if in a topic, null for DM
    const targetThreadId = ctx.threadInfo?.dbId || undefined;

    const job = await createCronJob(name, schedule, scheduleType, prompt, targetThreadId);
    if (job) {
      const nextRun = computeNextRun(job);
      const nextRunStr = nextRun
        ? new Date(nextRun).toLocaleString("en-US", {
            timeZone: "America/Sao_Paulo",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "computing...";

      await logEventV2("cron_created", `Cron job created: ${name}`, {
        job_id: job.id,
        schedule,
        schedule_type: scheduleType,
        prompt: prompt.substring(0, 100),
      }, ctx.threadInfo?.dbId);

      await ctx.reply(
        `✅ Cron job created!\n\n` +
        `Schedule: ${schedule} (${scheduleType})\n` +
        `Prompt: ${prompt}\n` +
        `Next run: ${nextRunStr}`
      );
    } else {
      await ctx.reply("Failed to create cron job. Check Supabase connection.");
    }
    return;
  }

  // /cron remove <number>
  if (args.startsWith("remove ") || args.startsWith("rm ") || args.startsWith("delete ")) {
    const numStr = args.split(/\s+/)[1];
    const num = parseInt(numStr);
    if (isNaN(num) || num < 1) {
      await ctx.reply("Usage: /cron remove <number>\n\nUse /cron list to see job numbers.");
      return;
    }

    // Fetch jobs with same filter as /cron list (hide expired one-shots)
    const allJobsR = await getAllCronJobs();
    const jobs = allJobsR.filter(j => !(j.schedule_type === "once" && !j.enabled));
    if (num > jobs.length) {
      await ctx.reply(`No job #${num}. You have ${jobs.length} job(s). Use /cron list to see them.`);
      return;
    }

    const job = jobs[num - 1];
    const deleted = await deleteCronJob(job.id);
    if (deleted) {
      await logEventV2("cron_deleted", `Cron job deleted: ${job.name}`, {
        job_id: job.id,
        schedule: job.schedule,
      }, ctx.threadInfo?.dbId);

      await ctx.reply(`🗑 Removed job #${num}: "${job.name}" (${job.schedule})`);
    } else {
      await ctx.reply("Failed to remove cron job. Check Supabase connection.");
    }
    return;
  }

  // /cron enable <number> / /cron disable <number>
  if (args.startsWith("enable ") || args.startsWith("disable ")) {
    const parts = args.split(/\s+/);
    const action = parts[0];
    const num = parseInt(parts[1]);
    if (isNaN(num) || num < 1) {
      await ctx.reply(`Usage: /cron ${action} <number>`);
      return;
    }

    const allJobsE = await getAllCronJobs();
    const jobs = allJobsE.filter(j => !(j.schedule_type === "once" && !j.enabled));
    if (num > jobs.length) {
      await ctx.reply(`No job #${num}. You have ${jobs.length} job(s).`);
      return;
    }

    const job = jobs[num - 1];
    const newEnabled = action === "enable";

    if (!supabase) {
      await ctx.reply("Supabase not connected.");
      return;
    }

    await supabase
      .from("cron_jobs")
      .update({ enabled: newEnabled, updated_at: new Date().toISOString() })
      .eq("id", job.id);

    const emoji = newEnabled ? "▶️" : "⏸";
    await ctx.reply(`${emoji} Job #${num} "${job.name}" ${newEnabled ? "enabled" : "disabled"}.`);
    return;
  }

  // Unknown subcommand
  await ctx.reply(
    "Usage:\n" +
    '/cron add "<schedule>" <prompt>\n' +
    "/cron list\n" +
    "/cron remove <number>\n" +
    "/cron enable <number>\n" +
    "/cron disable <number>"
  );
});

// /email command: check emails via provider abstraction (Gmail, Outlook, etc.)
bot.command("email", async (ctx) => {
  const args = (ctx.match || "").trim();

  // Check if any email accounts are authorized (provider-agnostic)
  const accounts = await getAuthorizedEmailAccounts();
  if (accounts.length === 0) {
    await ctx.reply(
      "⚠️ No email accounts authorized.\n\n" +
      "To set up email access:\n" +
      "For Gmail:\n" +
      "1. Create OAuth credentials in Google Cloud Console\n" +
      "2. Save credentials to ~/.claude-relay/google-credentials.json\n" +
      "3. Run: bun run src/google-oauth.ts\n" +
      "4. Visit the URL and authorize each account"
    );
    return;
  }

  // Default account is the first one
  const email = accounts[0];

  // /email - list recent inbox
  if (!args || args === "inbox") {
    try {
      await ctx.reply("📧 Fetching emails...");
      const emails = await listEmailsForRelay(email, { maxResults: 10, labelIds: ["INBOX"] });

      if (emails.length === 0) {
        await ctx.reply("No emails found in inbox.");
        return;
      }

      let text = `<b>📧 Inbox (${emails.length})</b> - ${email}\n\n`;
      emails.forEach((msg, i) => {
        const unread = msg.unread ? "🔵" : "⚪";
        const from = msg.from?.split("<")[0].trim() || "Unknown";
        const subject = msg.subject || "(No subject)";
        const date = msg.date ? new Date(msg.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
        text += `${unread} <b>${i + 1}.</b> ${from}\n`;
        text += `   ${subject}\n`;
        text += `   ${date} • ID: ${msg.id}\n\n`;
      });

      text += `Commands:\n/email read <id>\n/email send <to> <subject>\n/email search <query>`;

      try {
        await ctx.reply(text, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(text.replace(/<[^>]*>/g, ""));
      }
    } catch (error) {
      await ctx.reply(`❌ Failed to fetch emails: ${error}`);
    }
    return;
  }

  // /email read <id>
  if (args.startsWith("read ")) {
    const id = args.substring(5).trim();
    if (!id) {
      await ctx.reply("Usage: /email read <message_id>");
      return;
    }

    try {
      const msg = await getEmailForRelay(email, id);
      if (!msg) {
        await ctx.reply("Email not found.");
        return;
      }

      let text = `<b>📧 ${msg.subject || "(No subject)"}</b>\n\n`;
      text += `From: ${msg.from || "Unknown"}\n`;
      text += `Date: ${msg.date || "Unknown"}\n\n`;
      text += `${msg.body?.substring(0, 2000) || msg.snippet || "(No content)"}${msg.body && msg.body.length > 2000 ? "..." : ""}`;

      try {
        await ctx.reply(text, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(text.replace(/<[^>]*>/g, ""));
      }
    } catch (error) {
      await ctx.reply(`❌ Failed to read email: ${error}`);
    }
    return;
  }

  // /email search <query>
  if (args.startsWith("search ")) {
    const query = args.substring(7).trim();
    if (!query) {
      await ctx.reply("Usage: /email search <query>");
      return;
    }

    try {
      await ctx.reply(`🔍 Searching for: ${query}`);
      const emails = await listEmailsForRelay(email, { query, maxResults: 10 });

      if (emails.length === 0) {
        await ctx.reply("No emails found matching your search.");
        return;
      }

      let text = `<b>🔍 Search Results (${emails.length})</b>\n\n`;
      emails.forEach((msg, i) => {
        const unread = msg.unread ? "🔵" : "⚪";
        const from = msg.from?.split("<")[0].trim() || "Unknown";
        const subject = msg.subject || "(No subject)";
        text += `${unread} <b>${i + 1}.</b> ${from}\n   ${subject}\n   ID: ${msg.id}\n\n`;
      });

      try {
        await ctx.reply(text, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(text.replace(/<[^>]*>/g, ""));
      }
    } catch (error) {
      await ctx.reply(`❌ Search failed: ${error}`);
    }
    return;
  }

  // /email send <to> <subject>
  if (args.startsWith("send ")) {
    const parts = args.substring(5).trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply("Usage: /email send <email> <subject>\n\nReply to the next message with the body.");
      return;
    }

    const to = parts[0];
    const subject = parts.slice(1).join(" ");

    await ctx.reply(
      `📧 Send Email\n\n` +
      `To: ${to}\n` +
      `Subject: ${subject}\n\n` +
      `Reply with the message body, or "cancel" to abort.`
    );

    // Store pending send in context (simplified - would need state management)
    // For now, suggest using Claude to compose and send
    await ctx.reply(
      "💡 Tip: Just tell me to send an email in our chat, like:\n" +
      `"Send an email to ${to} with subject '${subject}' saying: Hello!"`
    );
    return;
  }

  // /email accounts - list authorized accounts
  if (args === "accounts") {
    let text = `<b>📧 Authorized Google Accounts</b>\n\n`;
    for (const acc of accounts) {
      text += `✅ ${acc}\n`;
    }
    text += `\nPrimary: ${accounts[0]}`;
    try {
      await ctx.reply(text, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(text.replace(/<[^>]*>/g, ""));
    }
    return;
  }

  // /email add <email> [provider] [--name "Display Name"]
  // Initiates OAuth flow for adding a new email account
  if (args.startsWith("add ")) {
    const addArgs = args.substring(4).trim();

    // Use typed parser for robust argument handling
    const parseResult = parseEmailAddArgs(addArgs);

    if (!parseResult.success) {
      await ctx.reply(`❌ ${parseResult.error}\n\n${parseResult.usage || EMAIL_ADD_USAGE}`);
      return;
    }

    const { email, provider: parsedProvider, displayName } = parseResult.data;

    // Determine final provider (parsed or auto-detected, defaulting to gmail)
    const finalProvider = parsedProvider || 'gmail';

    // Check for duplicate
    if (accounts.includes(email)) {
      await ctx.reply(`⚠️ Account ${email} is already authorized.`);
      return;
    }

    try {
      // Generate OAuth URL based on provider
      let authUrl: string;
      let credentialsFile: string;

      if (finalProvider === 'outlook') {
        authUrl = await getMicrosoftAuthUrl(email);
        credentialsFile = '~/.claude-relay/microsoft-credentials.json';
      } else {
        // Default to Gmail
        authUrl = await getGoogleAuthUrl(email);
        credentialsFile = '~/.claude-relay/google-credentials.json';
      }

      await ctx.reply(
        `📧 <b>Add Email Account</b>\n\n` +
        `Email: ${email}\n` +
        `Provider: ${getProviderDisplayName(finalProvider)}\n` +
        (displayName ? `Name: ${displayName}\n` : '') +
        `\n<b>Step 1:</b> Visit this URL to authorize:\n${authUrl}\n\n` +
        `<b>Step 2:</b> After authorizing, you'll get a code.\n` +
        `<b>Step 3:</b> Reply with: <code>/email verify ${email} YOUR_CODE</code>`,
        { parse_mode: "HTML" }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const providerName = getProviderDisplayName(finalProvider);
      const credentialsHint = finalProvider === 'outlook'
        ? 'Microsoft credentials: ~/.claude-relay/microsoft-credentials.json'
        : 'Google credentials: ~/.claude-relay/google-credentials.json';
      await ctx.reply(
        `❌ Failed to generate OAuth URL.\n\n` +
        `Make sure ${providerName} credentials are configured:\n` +
        `${credentialsHint}\n\n` +
        `Error: ${errorMsg}`
      );
    }
    return;
  }

  // /email verify <email> <code>
  // Completes OAuth flow by exchanging authorization code for tokens
  if (args.startsWith("verify ")) {
    const verifyInput = args.substring(7).trim();
    const parseResult = parseEmailVerifyArgs(verifyInput);

    if (!parseResult.success) {
      await ctx.reply(`❌ ${parseResult.error}\n\n${parseResult.usage}`);
      return;
    }

    const { email, code } = parseResult.data;

    // Validate email with provider detection
    const validation = validateEmailWithProvider(email);
    if (!validation.valid) {
      await ctx.reply(`❌ ${validation.error}`);
      return;
    }

    await ctx.reply("🔄 Verifying authorization...");

    // Determine provider for token exchange
    const provider = validation.provider || 'gmail';
    const tokenProvider = provider === 'outlook' ? 'microsoft' : 'google';

    try {
      // Exchange code for tokens based on provider
      const tokenData = provider === 'outlook'
        ? await exchangeMicrosoftCode(code, email)
        : await exchangeGoogleCode(code, email);

      // Store tokens via TokenManager (file + encrypted database)
      const oauthToken: OAuthToken = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(tokenData.expiry_date),
        scopes: tokenData.scope.split(' '),
      };
      await getTokenManager().storeToken(tokenProvider, email, oauthToken);

      // Register account in database for persistence
      const factory = getEmailProviderFactory();
      const registerResult = await factory.registerAccount({
        emailAddress: email,
        providerType: validation.provider || 'gmail',
      });

      if (!registerResult.success) {
        console.warn(`[Email] Database registration failed for ${email}: ${registerResult.error}`);
        // Continue - file-based token is saved, account will be discovered
      }

      await ctx.reply(
        `✅ <b>Account Added Successfully!</b>\n\n` +
        `Email: ${email}\n` +
        `Provider: ${getProviderDisplayName(validation.provider || 'gmail')}\n\n` +
        `You can now use /email to access this account.`,
        { parse_mode: "HTML" }
      );

      console.log(`[Email] Account authorized: ${email}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const parsed = parseOAuthError(errorMsg);
      await ctx.reply(
        `❌ <b>Authorization Failed</b>\n\n` +
        `${parsed.userMessage}\n\n` +
        `<b>Suggestion:</b> ${parsed.suggestion}`,
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  // /email remove <email> - Remove an email account
  if (args.startsWith("remove ")) {
    const email = args.substring(7).trim().toLowerCase();

    if (!email) {
      await ctx.reply("Usage: /email remove <email>");
      return;
    }

    // Validate email format
    const validation = validateEmailWithProvider(email);
    if (!validation.valid) {
      await ctx.reply(`❌ ${validation.error}`);
      return;
    }

    await ctx.reply(`🔄 Removing account ${email}...`);

    try {
      const factory = getEmailProviderFactory();
      const result = await factory.removeAccount(email);

      if (result.success) {
        await ctx.reply(
          `✅ <b>Account Removed</b>\n\n` +
          `Email: ${email}\n\n` +
          `The account has been deactivated and its tokens deleted.`,
          { parse_mode: "HTML" }
        );
        console.log(`[Email] Account removed: ${email}`);
      } else {
        await ctx.reply(
          `❌ Failed to remove account.\n\n` +
          `Error: ${result.error}`
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Error removing account: ${errorMsg}`);
    }
    return;
  }

  // /email list [accounts|drafts|starred|important] - list managed items or accounts
  if (args === "list" || args.startsWith("list ")) {
    const subArg = args.startsWith("list ") ? args.substring(5).trim() : "";

    // /email list accounts - show all authorized accounts with status
    if (subArg === "accounts" || subArg === "") {
      try {
        const factory = getEmailProviderFactory();
        const accountConfigs = await factory.discoverAccounts();

        let text = `<b>📧 Email Accounts (${accountConfigs.length})</b>\n\n`;

        if (accountConfigs.length === 0) {
          text += "No accounts configured.\n\n";
          text += "Add an account: /email add <email>";
        } else {
          accountConfigs.forEach((acc, i) => {
            const statusIcon = acc.isActive ? "✅" : "⏸";
            const syncIcon = acc.syncEnabled ? "🔄" : "⏸";
            const providerIcon = acc.providerType === 'gmail' ? '📥' :
                                 acc.providerType === 'outlook' ? '📤' : '📧';
            const namePart = acc.displayName ? ` (${acc.displayName})` : '';
            text += `${statusIcon} <b>${i + 1}.</b> ${providerIcon} ${acc.emailAddress}${namePart}\n`;
            text += `   Provider: ${acc.providerType} · Sync: ${syncIcon}\n\n`;
          });
          text += "Commands:\n/email add <email>\n/email inbox\n/email read <id>";
        }

        try {
          await ctx.reply(text, { parse_mode: "HTML" });
        } catch {
          await ctx.reply(text.replace(/<[^>]*>/g, ""));
        }
      } catch (error) {
        await ctx.reply(`❌ Failed to list accounts: ${error}`);
      }
      return;
    }

    try {
      await ctx.reply("📋 Fetching managed items...");

      let text = `<b>📋 Managed Email Items</b> - ${email}\n\n`;

      // If specific category requested
      if (subArg === "drafts") {
        const drafts = await listEmailsForRelay(email, { maxResults: 15, labelIds: ["DRAFT"] });
        text += `<b>Drafts (${drafts.length})</b>\n`;
        if (drafts.length === 0) {
          text += "No drafts found.\n";
        } else {
          drafts.forEach((msg, i) => {
            const subject = msg.subject || "(No subject)";
            const date = msg.date ? new Date(msg.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
            text += `${i + 1}. ${subject}\n   ${date} • ID: ${msg.id}\n`;
          });
        }
      } else if (subArg === "starred") {
        const starred = await listEmailsForRelay(email, { maxResults: 15, labelIds: ["STARRED"] });
        text += `<b>Starred (${starred.length})</b>\n`;
        if (starred.length === 0) {
          text += "No starred emails.\n";
        } else {
          starred.forEach((msg, i) => {
            const unread = msg.unread ? "🔵" : "⚪";
            const from = msg.from?.split("<")[0].trim() || "Unknown";
            const subject = msg.subject || "(No subject)";
            text += `${unread} ${i + 1}. ${from}: ${subject}\n   ID: ${msg.id}\n`;
          });
        }
      } else if (subArg === "important") {
        const important = await listEmailsForRelay(email, { maxResults: 15, labelIds: ["IMPORTANT"] });
        text += `<b>Important (${important.length})</b>\n`;
        if (important.length === 0) {
          text += "No important emails.\n";
        } else {
          important.forEach((msg, i) => {
            const unread = msg.unread ? "🔵" : "⚪";
            const from = msg.from?.split("<")[0].trim() || "Unknown";
            const subject = msg.subject || "(No subject)";
            text += `${unread} ${i + 1}. ${from}: ${subject}\n   ID: ${msg.id}\n`;
          });
        }
      } else {
        // Show summary of all categories
        const [drafts, starred, important] = await Promise.all([
          listEmailsForRelay(email, { maxResults: 5, labelIds: ["DRAFT"] }),
          listEmailsForRelay(email, { maxResults: 5, labelIds: ["STARRED"] }),
          listEmailsForRelay(email, { maxResults: 5, labelIds: ["IMPORTANT"] }),
        ]);

        text += `<b>Drafts (${drafts.length})</b>\n`;
        if (drafts.length === 0) {
          text += "  No drafts\n";
        } else {
          drafts.forEach((msg, i) => {
            const subject = msg.subject || "(No subject)";
            text += `  ${i + 1}. ${subject}\n`;
          });
        }

        text += `\n<b>Starred (${starred.length})</b>\n`;
        if (starred.length === 0) {
          text += "  No starred emails\n";
        } else {
          starred.forEach((msg, i) => {
            const unread = msg.unread ? "🔵" : "";
            const subject = msg.subject || "(No subject)";
            text += `  ${unread}${i + 1}. ${subject}\n`;
          });
        }

        text += `\n<b>Important (${important.length})</b>\n`;
        if (important.length === 0) {
          text += "  No important emails\n";
        } else {
          important.forEach((msg, i) => {
            const unread = msg.unread ? "🔵" : "";
            const subject = msg.subject || "(No subject)";
            text += `  ${unread}${i + 1}. ${subject}\n`;
          });
        }

        text += `\n<i>Use /email list drafts|starred|important for more details</i>`;
      }

      try {
        await ctx.reply(text, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(text.replace(/<[^>]*>/g, ""));
      }
    } catch (error) {
      await ctx.reply(`❌ Failed to list items: ${error}`);
    }
    return;
  }

  // Unknown subcommand
  await ctx.reply(
    "📧 Email Commands:\n\n" +
    "/email - Show inbox\n" +
    "/email inbox - Show inbox\n" +
    "/email list - Show drafts, starred, important\n" +
    "/email read <id> - Read email\n" +
    "/email search <query> - Search emails\n" +
    "/email send <to> <subject> - Compose email\n" +
    "/email add <email> [provider] - Add new account\n" +
    "/email verify <email> <code> - Complete OAuth\n" +
    "/email remove <email> - Remove account\n" +
    "/email accounts - List authorized accounts"
  );
});

// /stop - Emergency stop all bot operations
bot.command("stop", async (ctx) => {
  console.log("[STOP] Emergency stop requested");
  await ctx.reply("🛑 Stopping all bot operations...");
  await logEventV2("emergency_stop", "Emergency stop triggered via /stop command", {}, ctx.threadInfo?.dbId);
  process.exit(0);
});

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 80)}...`);

  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  try {
    await ctx.replyWithChatAction("typing");

    const enrichedPrompt = await buildPrompt(text, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
    const response = await processIntents(rawResponse, ctx.threadInfo?.dbId);

    // Check if Claude included [VOICE_REPLY] tag
    const wantsVoice = /\[VOICE_REPLY\]/i.test(response);
    const cleanResponse = response.replace(/\[VOICE_REPLY\]/gi, "").trim();

    if (!cleanResponse) {
      await sendResponse(ctx, "Sorry, I wasn't able to process that request. Please try again.");
      return;
    }

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", text);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", cleanResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("message", text.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    if (wantsVoice) {
      console.log(`[VOICE_REPLY] Tag detected, generating TTS for ${cleanResponse.length} chars`);
      const audioBuffer = await textToSpeech(cleanResponse);
      console.log(`[VOICE_REPLY] TTS result: ${audioBuffer ? audioBuffer.length + ' bytes' : 'null'}`);
      if (audioBuffer) {
        const audioPath = join(TEMP_DIR, `tts_${Date.now()}.ogg`);
        await writeFile(audioPath, audioBuffer);
        console.log(`[VOICE_REPLY] Sending voice message...`);
        await ctx.replyWithVoice(new InputFile(audioPath));
        console.log(`[VOICE_REPLY] Voice message sent`);
        await unlink(audioPath).catch(() => {});
      } else {
        console.log(`[VOICE_REPLY] TTS returned null, no voice sent`);
      }
    }
    await sendResponse(ctx, cleanResponse);
  } finally {
    await liveness.cleanup();
  }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const timestamp = Date.now();
    const ogaPath = join(UPLOADS_DIR, `voice_${timestamp}.oga`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(ogaPath, Buffer.from(buffer));

    const transcription = await transcribeAudio(ogaPath);
    await unlink(ogaPath).catch(() => {});

    console.log(`Transcription: ${transcription.substring(0, 80)}...`);

    const enrichedPrompt = await buildPrompt(transcription, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Voice]: ${transcription}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("voice_message", transcription.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    // Reply with voice if TTS is available
    console.log(`[Voice] Attempting TTS for response (${claudeResponse.length} chars)`);
    const audioBuffer = await textToSpeech(claudeResponse);
    console.log(`[Voice] TTS result: ${audioBuffer ? audioBuffer.length + ' bytes' : 'null'}`);
    if (audioBuffer) {
      const audioPath = join(TEMP_DIR, `tts_${Date.now()}.ogg`);
      console.log(`[Voice] Writing audio to: ${audioPath}`);
      await writeFile(audioPath, audioBuffer);
      console.log(`[Voice] Sending voice message to Telegram...`);
      await ctx.replyWithVoice(new InputFile(audioPath));
      console.log(`[Voice] Voice message sent successfully`);
      await unlink(audioPath).catch(() => {});
      // Also send text so it's searchable/readable
      console.log(`[Voice] Sending text follow-up...`);
      await sendResponse(ctx, claudeResponse);
      console.log(`[Voice] Complete!`);
    } else {
      console.log(`[Voice] No audio buffer, sending text only`);
      await sendResponse(ctx, claudeResponse);
    }
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  } finally {
    await liveness.cleanup();
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Analyze this image.";
    const enrichedPrompt = await buildPrompt(`[Image: ${filePath}]\n\n${caption}`, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);

    await unlink(filePath).catch(() => {});

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[Image] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("photo_message", caption.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  } finally {
    await liveness.cleanup();
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  const liveness = createLivenessReporter(ctx.chat.id, ctx.message.message_thread_id);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = sanitizeFilename(doc.file_name || `file_${timestamp}`);
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const enrichedPrompt = await buildPrompt(`[File: ${filePath}]\n\n${caption}`, ctx.threadInfo);
    const { text: rawResponse } = await callClaude(enrichedPrompt, ctx.threadInfo, liveness.onStreamEvent);
    const claudeResponse = await processIntents(rawResponse, ctx.threadInfo?.dbId);

    await unlink(filePath).catch(() => {});

    // V2 thread-aware logging
    if (ctx.threadInfo) {
      await insertThreadMessage(ctx.threadInfo.dbId, "user", `[File: ${doc.file_name}] ${caption}`);
      await insertThreadMessage(ctx.threadInfo.dbId, "assistant", claudeResponse);
      await maybeUpdateThreadSummary(ctx.threadInfo);
      await logEventV2("document_message", `${doc.file_name}`.substring(0, 100), {}, ctx.threadInfo.dbId);
    }

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  } finally {
    await liveness.cleanup();
  }
});

// ============================================================
// HELPERS
// ============================================================

async function buildPrompt(userMessage: string, threadInfo?: ThreadInfo): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Layer 1: Soul (personality)
  const soul = await getActiveSoul();

  // Layer 2: Memory context (facts + active goals)
  const memoryFacts = await getMemoryContext();
  const activeGoals = await getActiveGoals();

  // Semantic search — find memories relevant to the current message
  const relevantMemories = await getRelevantMemory(userMessage);

  // Layer 3: Thread context (summary + recent messages as fallback)
  let threadContext = "";
  if (threadInfo?.dbId) {
    if (threadInfo.summary) {
      threadContext += `\nTHREAD SUMMARY:\n${threadInfo.summary}\n`;
    }
    const recentMessages = await getRecentThreadMessages(threadInfo.dbId, 5);
    if (recentMessages.length > 0) {
      threadContext += "\nRECENT MESSAGES (this thread):\n";
      threadContext += recentMessages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
    }
  }

  let prompt = `${soul}\n\nCurrent time: ${timeStr}`;

  if (memoryFacts.length > 0) {
    prompt += "\n\nTHINGS I KNOW ABOUT THE USER:\n";
    prompt += memoryFacts.map((m) => `- ${m}`).join("\n");
  }

  if (activeGoals.length > 0) {
    prompt += "\n\nACTIVE GOALS:\n";
    prompt += activeGoals
      .map((g) => {
        let line = `- ${g.content}`;
        if (g.deadline) {
          const d = new Date(g.deadline);
          line += ` (deadline: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        }
        return line;
      })
      .join("\n");
  }

  if (relevantMemories.length > 0) {
    // Deduplicate: filter out memories already shown in facts or goals sections
    const shownContent = new Set([
      ...memoryFacts.map((f) => f.toLowerCase()),
      ...activeGoals.map((g) => g.content.toLowerCase()),
    ]);
    const uniqueRelevant = relevantMemories.filter(
      (m) => !shownContent.has(m.content.toLowerCase())
    );
    if (uniqueRelevant.length > 0) {
      prompt += "\n\nRELEVANT MEMORIES (semantically related to your message):\n";
      prompt += uniqueRelevant
        .map((m) => `- ${m.content} [${m.type}, relevance: ${(m.similarity * 100).toFixed(0)}%]`)
        .join("\n");
    }
  }

  if (threadContext) {
    prompt += threadContext;
  }

  if (skillRegistry) {
    prompt += `\n\n${skillRegistry}`;
  }

  prompt += `

MEMORY INSTRUCTIONS:
The "THINGS I KNOW ABOUT THE USER" list above is stored in a database. The ONLY way to manage it is by including these tags in your response text. They will be parsed, executed against the database, and stripped before delivery. Do NOT use filesystem tools (Read/Edit/Write) to manage memory — those cannot modify the database.

To save a new fact:
[REMEMBER: concise fact about the user]

Keep facts very concise (under 15 words each). Only remember genuinely useful things.

To remove an outdated or wrong fact or memory (search text must partially match the existing entry):
[FORGET: search text matching the entry to remove]

IMPORTANT: Always include these tags directly in your response text, never in tool calls. Multiple tags can appear in the same response. They are automatically removed before the user sees your message.

GOALS:
You can track goals for the user. When the user mentions a goal, objective, or something they want to achieve:

[GOAL: concise description of the goal]

To set a goal with a deadline (use ISO date format):
[GOAL: description | DEADLINE: YYYY-MM-DD]

When a goal is accomplished, mark it done:
[DONE: search text matching the goal]

To trigger a voice reply:
[VOICE_REPLY]

SCHEDULING:
You can create scheduled tasks that will run automatically. Include this tag in your response:

[CRON: <schedule> | <prompt>]

Schedule formats:
- Cron: "0 9 * * *" (5-field, e.g., daily at 9am)
- Interval: "every 2h" or "every 30m" (recurring)
- One-shot: "in 20m" or "in 1h" (runs once then auto-disables)

Examples:
[CRON: 0 9 * * 1 | check project deadlines and report status]
[CRON: every 4h | check if user has any pending reminders]
[CRON: in 30m | remind user about the meeting]

Use this when the user asks you to remind them of something, schedule periodic checks, or when you identify something that should be monitored regularly. The tag will be removed before delivery.

User: ${userMessage}`;

  return prompt.trim();
}

// Convert Claude's Markdown output to Telegram-compatible HTML.
// Handles: bold, italic, strikethrough, code blocks, inline code, links.
// Escapes HTML entities first, then applies formatting conversions.
function markdownToTelegramHtml(text: string): string {
  // Step 1: Extract code blocks and inline code to protect them from other transformations
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Protect fenced code blocks (```lang\n...\n```)
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const langAttr = lang ? ` class="language-${lang}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    inlineCodes.push(`<code>${escaped}</code>`);
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
  });

  // Step 2: Escape HTML entities in remaining text
  result = result.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Step 3: Convert markdown formatting to HTML
  // Bold+italic (***text***)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  // Bold (**text**)
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic (*text*) — but not inside words like file*name
  result = result.replace(/(?<!\w)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\w)/g, "<i>$1</i>");
  // Strikethrough (~~text~~)
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Step 4: Restore protected code blocks and inline code
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  result = result.replace(/\x00INLINECODE(\d+)\x00/g, (_, i) => inlineCodes[parseInt(i)]);

  return result;
}

async function sendResponse(ctx: CustomContext, response: string): Promise<void> {
  if (!response || response.trim().length === 0) {
    console.warn("Empty response — skipping Telegram send");
    return;
  }

  const MAX_LENGTH = 4000;
  const html = markdownToTelegramHtml(response);

  const sendChunk = async (chunk: string) => {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (err: any) {
      // If HTML parsing fails, fall back to plain text
      console.warn("HTML parse failed, falling back to plain text:", err.message);
      await ctx.reply(response.length <= MAX_LENGTH ? response : chunk);
    }
  };

  if (html.length <= MAX_LENGTH) {
    await sendChunk(html);
    return;
  }

  const chunks = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await sendChunk(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");

// Verify Claude CLI is available and log version
const versionCheck = Bun.spawnSync([CLAUDE_PATH, "--version"]);
if (versionCheck.success) {
  const version = new TextDecoder().decode(versionCheck.stdout).trim();
  console.log(`Claude CLI: ${version}`);
} else {
  console.warn(`WARNING: Claude CLI not found at '${CLAUDE_PATH}' - relay will fail on message processing`);
}

console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
console.log(`Supabase: ${supabase ? "connected" : "disabled"}`);
console.log(`Voice transcription: ${GROQ_API_KEY ? "Groq Whisper API" : "disabled (no GROQ_API_KEY)"}`);
console.log(`Whisper model: ${GROQ_WHISPER_MODEL}`);
console.log(`FFmpeg path: ${FFMPEG_PATH}`);
console.log(`Voice responses (TTS): ${TTS_PROVIDER === "edge" ? `Edge TTS (${EDGE_TTS_VOICE} @ ${EDGE_TTS_SPEED}x)` : TTS_PROVIDER === "elevenlabs" && ELEVENLABS_API_KEY ? "ElevenLabs v3" : "Edge TTS (fallback)"}`);
console.log("Thread support: enabled (Grammy auto-thread)");
console.log(`Heartbeat: ${supabase ? "will start after boot" : "disabled (no Supabase)"}`);
console.log(`Heartbeat routing: ${TELEGRAM_GROUP_ID ? `group ${TELEGRAM_GROUP_ID} (topic thread)` : "DM (no TELEGRAM_GROUP_ID)"}`);

await logEventV2("bot_started", "Relay started");

// Global error handler — prevents crashes from killing the relay
bot.catch((err) => {
  console.error("Bot error caught:", err.message || err);
  logEventV2("bot_error", String(err.message || err).substring(0, 200)).catch(() => {});
});

// Catch unhandled rejections so the process doesn't die
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  logEventV2("unhandled_rejection", String(reason).substring(0, 200)).catch(() => {});
});

bot.start({
  onStart: async () => {
    console.log("Bot is running!");

    // Start heartbeat timer from Supabase config
    const hbConfig = await getHeartbeatConfig();
    if (hbConfig?.enabled) {
      startHeartbeat(hbConfig.interval_minutes);
    } else {
      console.log("Heartbeat: disabled (no config or not enabled)");
    }

    // Start cron scheduler
    startCronScheduler();

    // Start token refresh scheduler (proactive OAuth token refresh)
    startTokenRefreshScheduler();
  },
});
