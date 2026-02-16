/**
 * Memory Module - Enhanced for Autonomous Agent System
 *
 * Persistent facts, goals, actions, strategies, and reflections stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [ACTION: task | PRIORITY: 1-5]
 *   [STRATEGY: direction]
 *   [REFLECTION: insight]
 *   [BLOCKED: reason]
 *   [DONE: search text]
 *   [FORGET: search text]
 *   [CRON: schedule | prompt]
 *   [VOICE_REPLY]
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Parse Claude's response for memory intent tags.
 * Saves to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;
  const stats = { remembered: 0, goals: 0, actions: 0, strategies: 0, reflections: 0, completed: 0, forgotten: 0, blocked: 0 };

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "fact",
      content: match[1].trim(),
      status: "active",
    });
    clean = clean.replace(match[0], "");
    stats.remembered++;
  }

  // [FORGET: search text to remove]
  for (const match of response.matchAll(/\[FORGET:\s*(.+?)\]/gi)) {
    const searchText = match[1].trim();
    const { data } = await supabase
      .from("memory")
      .select("id")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase.from("memory").delete().eq("id", data[0].id);
      stats.forgotten++;
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    await supabase.from("memory").insert({
      type: "goal",
      content: match[1].trim(),
      deadline: match[2]?.trim() || null,
      status: "active",
      priority: 3,
    });
    clean = clean.replace(match[0], "");
    stats.goals++;
  }

  // [ACTION: task description | PRIORITY: 1-5]
  for (const match of response.matchAll(
    /\[ACTION:\s*(.+?)(?:\s*\|\s*PRIORITY:\s*(\d))?\]/gi
  )) {
    const priority = match[2] ? parseInt(match[2]) : 3;
    await supabase.from("memory").insert({
      type: "action",
      content: match[1].trim(),
      priority: Math.min(5, Math.max(1, priority)),
      status: "pending",
    });
    clean = clean.replace(match[0], "");
    stats.actions++;
  }

  // [STRATEGY: strategic direction]
  for (const match of response.matchAll(/\[STRATEGY:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "strategy",
      content: match[1].trim(),
      status: "active",
      weight: 2.5,
    });
    clean = clean.replace(match[0], "");
    stats.strategies++;
  }

  // [REFLECTION: insight or lesson]
  for (const match of response.matchAll(/\[REFLECTION:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "reflection",
      content: match[1].trim(),
      status: "active",
    });
    clean = clean.replace(match[0], "");
    stats.reflections++;
  }

  // [BLOCKED: reason for blocking]
  for (const match of response.matchAll(/\[BLOCKED:\s*(.+?)\]/gi)) {
    const reason = match[1].trim();
    // Find most recent active goal/action and mark it blocked
    const { data } = await supabase
      .from("memory")
      .select("id")
      .in("type", ["goal", "action"])
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("memory")
        .update({
          status: "blocked",
          metadata: { blocked_reason: reason, blocked_at: new Date().toISOString() }
        })
        .eq("id", data[0].id);
      stats.blocked++;
    }
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal/action]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const searchText = match[1].trim();
    const { data } = await supabase
      .from("memory")
      .select("id, type")
      .or(`type.eq.goal,type.eq.action`)
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (data?.[0]) {
      const updateData: any = {
        status: "completed",
        completed_at: new Date().toISOString(),
      };

      // If it was a goal, also change type to completed_goal
      if (data[0].type === "goal") {
        updateData.type = "completed_goal";
      }

      await supabase
        .from("memory")
        .update(updateData)
        .eq("id", data[0].id);

      stats.completed++;
    }
    clean = clean.replace(match[0], "");
  }

  // Log stats if anything happened
  const totalOps = Object.values(stats).reduce((a, b) => a + b, 0);
  if (totalOps > 0) {
    console.log("[Memory] Processed:", stats);
  }

  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 * Enhanced to include strategies, actions, and reflections.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "";

  const parts: string[] = [];

  // Try RPC first (if migration has been run)
  try {
    const [factsResult, goalsResult, strategiesResult, actionsResult] = await Promise.all([
      supabase.from("memory").select("content").eq("type", "fact").eq("status", "active").order("created_at", { ascending: false }).limit(20),
      supabase.rpc("get_active_goals_with_children"),
      supabase.rpc("get_strategies").catch(() => ({ data: [] })),
      supabase.rpc("get_pending_actions").catch(() => ({ data: [] })),
    ]);

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              const blocked = g.status === "blocked" ? " [BLOCKED]" : "";
              const children = g.child_count > 0 ? ` [${g.child_count} sub-tasks]` : "";
              const priority = g.priority ? `[P${g.priority}] ` : "";
              return `- ${priority}${g.content}${deadline}${blocked}${children}`;
            })
            .join("\n")
      );
    }

    if (strategiesResult.data?.length) {
      parts.push(
        "STRATEGIES:\n" +
          strategiesResult.data.map((s: any) => `- ${s.content}`).join("\n")
      );
    }

    if (actionsResult.data?.length) {
      parts.push(
        "PENDING ACTIONS:\n" +
          actionsResult.data
            .slice(0, 10)
            .map((a: any) => `- [P${a.priority || 3}] ${a.content}`)
            .join("\n")
      );
    }

    if (parts.length > 0) {
      return parts.join("\n\n");
    }
  } catch (error) {
    // RPC functions don't exist, fall through to direct queries
    console.log("[Memory] RPC not available, using direct queries");
  }

  // Fallback: direct queries to memory table
  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase
        .from("memory")
        .select("content")
        .eq("type", "fact")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("memory")
        .select("content, deadline, priority, status")
        .eq("type", "goal")
        .neq("status", "completed")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              const blocked = g.status === "blocked" ? " [BLOCKED]" : "";
              return `- ${g.content}${deadline}${blocked}`;
            })
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("[Memory] Query error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
  matchCount: number = 5
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query, match_count: matchCount, table: "messages" },
    });

    if (error || !data?.length) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      data
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}

/**
 * Get weighted memory search results.
 * Uses the enhanced search_weighted_memory RPC if available.
 */
export async function getWeightedMemoryContext(
  supabase: SupabaseClient | null,
  query: string,
  matchCount: number = 15
): Promise<string> {
  if (!supabase) return "";

  try {
    // Try weighted search first
    const { data, error } = await supabase.rpc("search_weighted_memory", {
      query_text: query,
      match_count: matchCount,
    });

    if (error || !data?.length) {
      // Fall back to regular search
      return getRelevantContext(supabase, query, matchCount);
    }

    const grouped: Record<string, string[]> = {};

    for (const item of data) {
      const type = item.type || "other";
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(item.content);
    }

    const parts: string[] = [];
    if (grouped.goal) parts.push("RELEVANT GOALS:\n" + grouped.goal.map(g => `- ${g}`).join("\n"));
    if (grouped.strategy) parts.push("RELEVANT STRATEGIES:\n" + grouped.strategy.map(s => `- ${s}`).join("\n"));
    if (grouped.action) parts.push("RELEVANT ACTIONS:\n" + grouped.action.map(a => `- ${a}`).join("\n"));
    if (grouped.fact) parts.push("RELEVANT FACTS:\n" + grouped.fact.map(f => `- ${f}`).join("\n"));
    if (grouped.reflection) parts.push("RELEVANT REFLECTIONS:\n" + grouped.reflection.map(r => `- ${r}`).join("\n"));

    return parts.join("\n\n");
  } catch {
    return getRelevantContext(supabase, query, matchCount);
  }
}

/**
 * Get recent reflections for agent context.
 */
export async function getRecentReflections(
  supabase: SupabaseClient | null,
  limit: number = 5
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data } = await supabase
      .from("memory")
      .select("content, created_at")
      .eq("type", "reflection")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!data?.length) return "";

    return (
      "RECENT REFLECTIONS:\n" +
      data
        .map((r: any) => {
          const date = new Date(r.created_at).toLocaleDateString();
          return `- [${date}] ${r.content}`;
        })
        .join("\n")
    );
  } catch {
    return "";
  }
}

/**
 * Log a system event to memory.
 */
export async function logSystemEvent(
  supabase: SupabaseClient | null,
  content: string,
  metadata: Record<string, any> = {}
): Promise<void> {
  if (!supabase) return;

  try {
    await supabase.from("memory").insert({
      type: "system_event",
      content,
      metadata,
      status: "active",
    });
  } catch (error) {
    console.error("[Memory] Failed to log system event:", error);
  }
}
