import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://nlkgqooefwbupwubloae.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sa2dxb29lZndidXB3dWJsb2FlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTA1NTMwNCwiZXhwIjoyMDg2NjMxMzA0fQ.8nzC2iWY59-nGVNxJJY3fE2gP_yn3ZVGOuCfn4pgBSw"
);

const { data, error } = await supabase
  .from("memory")
  .select("type, status, content")
  .or("status.eq.active,status.eq.blocked,status.is.null")
  .order("type");

if (error) {
  console.error("Error:", error);
  process.exit(1);
}

console.log("=== MEMORY STATE SUMMARY ===");
const byType: Record<string, typeof data> = {};
data.forEach(row => {
  if (!byType[row.type]) byType[row.type] = [];
  byType[row.type].push(row);
});

Object.entries(byType).sort((a,b) => b[1].length - a[1].length).forEach(([type, items]) => {
  console.log(`\n${type.toUpperCase()}: ${items.length}`);
  if (type === "goal" || type === "preference") {
    items.forEach(g => console.log(" -", (g.content || "").substring(0, 70), `(${g.status || "active"})`));
  }
});

console.log("\n=== TOTALS ===");
console.log("Active entries:", data.length);
