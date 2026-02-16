import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function main() {
  // Get all goals
  const { data: goals, error: goalsError } = await supabase
    .from("global_memory")
    .select("id, type, content, created_at, deadline, priority")
    .eq("type", "goal")
    .order("priority", { ascending: true });

  if (goalsError) {
    console.error("Goals error:", goalsError);
  }

  // Get all actions
  const { data: actions, error: actionsError } = await supabase
    .from("global_memory")
    .select("id, type, content, created_at, priority")
    .eq("type", "action")
    .order("priority", { ascending: true });

  if (actionsError) {
    console.error("Actions error:", actionsError);
  }

  // Check for potential corrupted entries (malformed content)
  const { data: allEntries, error: allError } = await supabase
    .from("global_memory")
    .select("id, type, content");

  if (allError) {
    console.error("All error:", allError);
  }

  // Find entries with truncated/unclosed brackets
  const corrupted = allEntries?.filter((e) => {
    const openBrackets = (e.content.match(/\[/g) || []).length;
    const closeBrackets = (e.content.match(/\]/g) || []).length;
    return openBrackets !== closeBrackets;
  });

  console.log("=== ACTIVE GOALS ===");
  console.log(JSON.stringify(goals, null, 2));
  console.log("\n=== ACTIVE ACTIONS ===");
  console.log(JSON.stringify(actions, null, 2));
  console.log("\n=== POTENTIALLY CORRUPTED (mismatched brackets) ===");
  console.log(JSON.stringify(corrupted, null, 2));

  // Count by type
  const typeCounts: Record<string, number> = {};
  allEntries?.forEach((e) => {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  });
  console.log("\n=== TYPE COUNTS ===");
  console.log(JSON.stringify(typeCounts, null, 2));
}

main().catch(console.error);
