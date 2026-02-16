import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function cleanupGoals() {
  console.log("=== AGGRESSIVE GOAL CLEANUP ===\n");

  const { data: goals, error } = await supabase
    .from("memory")
    .select("id, content, status, created_at, priority")
    .eq("type", "goal")
    .eq("status", "active");

  if (error) {
    console.error("Error:", error);
    return;
  }

  console.log(`Found ${goals?.length || 0} active goals\n`);

  const toArchive: string[] = [];
  const keepCategories = new Set<string>();

  // Goals we want to keep (high-level parent goals)
  const keepPatterns = [
    "research and integrate new ai agent frameworks",
    "monitor claude code updates",
    "run a/b tests",
    "maintain self-assessment score",
    "implement reflexion pattern",
    "build experience-based learning",
    "email provider connection",
    "telegram email interface",
  ];

  goals?.forEach((g) => {
    const content = g.content.toLowerCase();

    // Archive junk entries
    if (content.includes("your goal here") || content.includes("[done:") || content.includes("]`, `[done:")) {
      toArchive.push(g.id);
      console.log(`[JUNK] ${g.content.substring(0, 40)}`);
      return;
    }

    // Archive all the granular subtasks (Gmail OAuth steps, MCP steps, etc)
    if (
      content.includes("create oauth") ||
      content.includes("implement oauth") ||
      content.includes("add gmail") ||
      content.includes("build token") ||
      content.includes("set up google cloud") ||
      content.includes("enable gmail api") ||
      content.includes("configure oauth") ||
      content.includes("integrate oauth") ||
      content.includes("implement list operation") ||
      content.includes("implement read operation") ||
      content.includes("implement send operation") ||
      content.includes("gmail mcp server") ||
      content.includes("fetching api client") ||
      content.includes("database schema and token") ||
      content.includes("provider abstraction") ||
      content.includes("token management") ||
      content.includes("secure token storage") ||
      content.includes("add task orchestration") ||
      content.includes("build background execution") ||
      content.includes("implement telegram notification") ||
      content.includes("create persistent task queue")
    ) {
      toArchive.push(g.id);
      console.log(`[SUBTASK] ${g.content.substring(0, 40)}`);
      return;
    }

    // Archive blocked goals
    if (content.includes("blocked")) {
      toArchive.push(g.id);
      console.log(`[BLOCKED] ${g.content.substring(0, 40)}`);
      return;
    }

    // Archive duplicates of same themes
    if (
      content.includes("establish autonomous email") ||
      content.includes("establish proactive email") ||
      content.includes("email sync pipeline") ||
      content.includes("claude email intelligence") ||
      content.includes("set up programmatic email")
    ) {
      // Keep only "Email Provider Connection" as the parent
      toArchive.push(g.id);
      console.log(`[DUP EMAIL] ${g.content.substring(0, 40)}`);
      return;
    }
  });

  console.log(`\n=== ARCHIVING ${toArchive.length} GOALS ===`);

  if (toArchive.length > 0) {
    const { error: updateError } = await supabase
      .from("memory")
      .update({ status: "archived" })
      .in("id", toArchive);

    if (updateError) {
      console.error("Error:", updateError);
    } else {
      console.log("Archived successfully!");
    }
  }

  // Show remaining
  const { data: remaining } = await supabase
    .from("memory")
    .select("content")
    .eq("type", "goal")
    .eq("status", "active");

  console.log(`\n=== REMAINING ${remaining?.length || 0} GOALS ===`);
  remaining?.forEach((g, i) => console.log(`${i + 1}. ${g.content.substring(0, 60)}`));
}

cleanupGoals().catch(console.error);
