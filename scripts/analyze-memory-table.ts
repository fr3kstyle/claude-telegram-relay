#!/usr/bin/env bun
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || ""
);

async function analyze() {
  const { data, error } = await supabase
    .from("memory")
    .select("id, type, content, status, created_at")
    .eq("status", "blocked")
    .order("created_at", { ascending: true });

  if (error) {
    console.log("Error:", error);
    return;
  }

  console.log("=== BLOCKED ITEMS ===\n");

  // Group by blocker type
  const blockers: Record<string, typeof data> = {};
  data?.forEach(item => {
    let blockerType = "other";
    const c = item.content || "";
    if (c.includes("OAuth") || c.includes("Gmail") || c.includes("Google")) blockerType = "oauth";
    else if (c.includes("migration") || c.includes("schema")) blockerType = "migration";
    else if (c.includes("manual")) blockerType = "manual";

    if (!blockers[blockerType]) blockers[blockerType] = [];
    blockers[blockerType].push(item);
  });

  Object.entries(blockers).forEach(([type, items]) => {
    console.log(`${type.toUpperCase()} (${items.length}):`);
    items.slice(0, 5).forEach(item => {
      console.log(`  - ${(item.content || "").substring(0, 70)}...`);
    });
    if (items.length > 5) console.log(`  ... and ${items.length - 5} more`);
    console.log("");
  });

  // Check pending actions count
  const { count: pendingActions } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .eq("type", "action")
    .eq("status", "pending");

  console.log(`\nTotal pending actions: ${pendingActions}`);

  // Check orphan actions (no parent_id)
  const { count: orphanActions } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .eq("type", "action")
    .eq("status", "pending")
    .is("parent_id", null);

  console.log(`Orphan actions (no parent_id): ${orphanActions}`);

  // Check duplicate goals
  const { data: goals } = await supabase
    .from("memory")
    .select("content")
    .eq("type", "goal")
    .eq("status", "active");

  const goalContent = goals?.map(g => (g.content || "").substring(0, 50).toLowerCase()) || [];
  const duplicates = goalContent.filter((c, i) => goalContent.indexOf(c) !== i);
  console.log(`Duplicate goals (first 50 chars): ${duplicates.length}`);

  // Check stale items (older than 7 days, still pending)
  const { count: staleItems } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .in("status", ["pending", "active"])
    .lt("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  console.log(`Stale items (>7 days old): ${staleItems}`);
}

analyze();
