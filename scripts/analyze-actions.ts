import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function analyzeActions() {
  const { data: actions } = await supabase
    .from("memory")
    .select("id, content, priority, status, parent_id, created_at")
    .eq("type", "action")
    .in("status", ["pending", "active"])
    .order("created_at", { ascending: true });

  console.log("=== ACTION AGING ===");
  const now = Date.now();
  const ageGroups: Record<string, number> = { "<1d": 0, "1-3d": 0, "3-7d": 0, ">7d": 0 };
  actions?.forEach(a => {
    const age = (now - new Date(a.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (age < 1) ageGroups["<1d"]++;
    else if (age < 3) ageGroups["1-3d"]++;
    else if (age < 7) ageGroups["3-7d"]++;
    else ageGroups[">7d"]++;
  });
  console.log(JSON.stringify(ageGroups, null, 2));

  console.log("\n=== SIMILAR ACTION CLUSTERS ===");
  const clusters: Record<string, any[]> = {};
  actions?.forEach(a => {
    const keywords = ["oauth", "gmail", "email", "telegram", "schema", "migrate"];
    keywords.forEach(kw => {
      if (a.content.toLowerCase().includes(kw)) {
        const key = kw;
        if (!clusters[key]) clusters[key] = [];
        clusters[key].push(a);
      }
    });
  });

  Object.entries(clusters)
    .filter(([k, v]) => v.length > 5)
    .forEach(([kw, items]) => {
      console.log(`\n"${kw}" appears in ${items.length} pending actions:`);
      items.slice(0, 5).forEach(a => {
        console.log(`  - ${a.content.substring(0, 60)}...`);
      });
    });

  const orphans = actions?.filter(a => !a.parent_id).length || 0;
  console.log("\n=== ORPHAN ACTIONS ===");
  console.log("Actions without parent_id:", orphans, "of", actions?.length || 0);
}

analyzeActions().catch(console.error);
