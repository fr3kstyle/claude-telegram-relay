import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function testGoalHygiene() {
  const daysThreshold = 7;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysThreshold);

  // Find orphan actions older than threshold
  const { data: orphanActions, error: orphanError } = await supabase
    .from("global_memory")
    .select("id, content, priority, created_at")
    .eq("type", "action")
    .eq("status", "pending")
    .is("parent_id", null)
    .lt("created_at", cutoffDate.toISOString());

  if (orphanError) {
    console.log("Error finding orphans:", orphanError.message);
    return;
  }

  console.log("=== ORPHAN ACTIONS (older than 7 days, no parent) ===");
  console.log("Count:", orphanActions?.length || 0);
  orphanActions?.forEach((a) => console.log("-", a.content?.substring(0, 60), `(P${a.priority})`));

  // Find malformed entries
  const { data: malformed, error: malformedError } = await supabase
    .from("global_memory")
    .select("id, content, type")
    .or("content.is.null,content.eq.");

  if (malformedError) {
    console.log("Error finding malformed:", malformedError.message);
    return;
  }

  console.log("\n=== MALFORMED ENTRIES (null/empty content) ===");
  console.log("Count:", malformed?.length || 0);
  malformed?.forEach((m) => console.log("-", m.type, ":", m.content?.substring(0, 40)));

  // Check for mismatched brackets
  const { data: all } = await supabase.from("global_memory").select("id, content");
  const bracketMismatch = all?.filter((e) => {
    const opens = (e.content?.match(/\[/g) || []).length;
    const closes = (e.content?.match(/\]/g) || []).length;
    return opens !== closes;
  });

  console.log("\n=== MISMATCHED BRACKETS ===");
  console.log("Count:", bracketMismatch?.length || 0);
  bracketMismatch?.forEach((e) => console.log("-", e.content?.substring(0, 60)));

  // Summary stats
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

  console.log("\n=== SUMMARY ===");
  console.log("Active goals:", totalGoals || 0);
  console.log("Pending actions:", totalActions || 0);
  console.log("Orphan actions (old):", orphanActions?.length || 0);
  console.log("Malformed entries:", malformed?.length || 0);
  console.log("Bracket mismatches:", bracketMismatch?.length || 0);
}

testGoalHygiene().catch(console.error);
