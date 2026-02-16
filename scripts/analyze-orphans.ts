#!/usr/bin/env bun
/**
 * Analyze and optionally archive orphan actions from the memory table.
 *
 * Orphan actions are pending actions with no parent_id (not linked to any goal).
 * These accumulate from autonomous agent cycles and can become noise.
 *
 * Usage:
 *   bun run scripts/analyze-orphans.ts           # Dry run - show what would be archived
 *   bun run scripts/analyze-orphans.ts --archive # Actually archive orphan actions
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || ""
);

const shouldArchive = process.argv.includes("--archive");

async function main() {
  // Get all orphan actions
  const { data: orphans, error } = await supabase
    .from("memory")
    .select("id, content, priority, created_at")
    .eq("type", "action")
    .eq("status", "pending")
    .is("parent_id", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching orphans:", error);
    process.exit(1);
  }

  console.log(`\n=== ORPHAN ACTION ANALYSIS ===\n`);
  console.log(`Total orphan actions: ${orphans?.length || 0}\n`);

  if (!orphans || orphans.length === 0) {
    console.log("No orphan actions found. Memory is clean!\n");
    return;
  }

  // Categorize by keywords
  const categories: Record<string, typeof orphans> = {};

  orphans.forEach((item) => {
    const c = (item.content || "").toLowerCase();
    let category = "other";

    if (c.includes("outlook") || c.includes("microsoft")) category = "outlook";
    else if (c.includes("oauth") || c.includes("token")) category = "oauth";
    else if (c.includes("test") || c.includes("spec")) category = "testing";
    else if (c.includes("document") || c.includes("readme")) category = "docs";
    else if (c.includes("refactor") || c.includes("extract")) category = "refactor";
    else if (c.includes("cron") || c.includes("heartbeat")) category = "scheduling";
    else if (c.includes("migration") || c.includes("schema")) category = "database";
    else if (c.includes("memory") || c.includes("goal")) category = "memory-system";
    else if (c.includes("email") || c.includes("gmail")) category = "email";
    else if (c.includes("backup") || c.includes("credential")) category = "ops";
    else if (c.includes("create") || c.includes("add ")) category = "create-code";
    else if (c.includes("verify") || c.includes("validate")) category = "validation";

    if (!categories[category]) categories[category] = [];
    categories[category].push(item);
  });

  // Show categories
  Object.entries(categories)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([cat, items]) => {
      console.log(`${cat}: ${items.length} actions`);
      items.slice(0, 2).forEach((item) => {
        console.log(`  - ${(item.content || "").substring(0, 70)}...`);
      });
      if (items.length > 2) {
        console.log(`  ... and ${items.length - 2} more`);
      }
      console.log("");
    });

  if (shouldArchive) {
    console.log("\n📦 Archiving orphan actions...\n");

    const ids = orphans.map((o) => o.id);
    const { error: updateError } = await supabase
      .from("memory")
      .update({ status: "archived" })
      .in("id", ids);

    if (updateError) {
      console.error("Error archiving:", updateError);
      process.exit(1);
    }

    console.log(`✅ Archived ${orphans.length} orphan actions\n`);
  } else {
    console.log("\n💡 Run with --archive to actually archive these actions\n");
  }
}

main();
