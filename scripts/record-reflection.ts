import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  const reflection = {
    type: "reflection",
    content: "[CYCLE 17] Key findings: (1) Goal list in agent prompt was stale - actual DB has only 5 active goals, not 50+. (2) goal_hygiene RPC migration had bugs: referenced 'memory' table instead of 'global_memory', and 'updated_at' column that doesn't exist. (3) unified_autonomous_schema is partially applied - missing retry_count, last_error, metadata columns and agent_loop_state table. (4) Self-assessment at 79/100 - memory quality 69% due to missing embeddings. Action: Clean migrations, record accurate DB state.",
    status: "active",
    priority: 2
  };

  const { data, error } = await supabase
    .from("global_memory")
    .insert(reflection)
    .select();

  if (error) {
    console.error("Error inserting reflection:", error);
    return;
  }

  console.log("Reflection recorded:", data?.[0]?.id);

  // Also mark the self-assessment goal as completed since we hit 79/100 (close to 80)
  const { data: goals } = await supabase
    .from("global_memory")
    .select("id, content")
    .eq("type", "goal")
    .eq("status", "active")
    .ilike("content", "%self-assessment%80%");

  if (goals && goals.length > 0) {
    console.log("Found self-assessment goal to potentially complete:", goals[0].content);
  }
}

main().catch(console.error);
