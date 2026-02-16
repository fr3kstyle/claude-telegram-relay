#!/usr/bin/env bun
/**
 * Memory Hygiene Script
 * Cleans up orphan actions, blocked items, and stale entries
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || ""
);

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

async function cleanup() {
  console.log("=== MEMORY HYGIENE ===\n");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (will make changes)"}`);
  console.log("");

  // 1. Archive blocked items (they require external action)
  console.log("1. BLOCKED ITEMS:");
  const { data: blocked, error: blockedErr } = await supabase
    .from("memory")
    .select("id, content")
    .eq("status", "blocked");

  if (blockedErr) {
    console.log("   Error:", blockedErr.message);
  } else {
    console.log(`   Found: ${blocked?.length || 0} blocked items`);
    if (!DRY_RUN && blocked && blocked.length > 0) {
      const ids = blocked.map(b => b.id);
      const { error: updateErr } = await supabase
        .from("memory")
        .update({ status: "archived", metadata: { archived_reason: "blocked_cleanup", archived_at: new Date().toISOString() } })
        .in("id", ids);
      if (updateErr) {
        console.log("   Error archiving:", updateErr.message);
      } else {
        console.log(`   Archived: ${ids.length} blocked items`);
      }
    }
  }
  console.log("");

  // 2. Archive orphan actions (no parent goal)
  console.log("2. ORPHAN ACTIONS:");
  const { data: orphans, error: orphanErr } = await supabase
    .from("memory")
    .select("id, content, priority")
    .eq("type", "action")
    .eq("status", "pending")
    .is("parent_id", null)
    .order("priority", { ascending: true });

  if (orphanErr) {
    console.log("   Error:", orphanErr.message);
  } else {
    console.log(`   Found: ${orphans?.length || 0} orphan actions`);
    if (orphans && orphans.length > 0) {
      console.log("   Top 5 by priority:");
      orphans.slice(0, 5).forEach(o => {
        console.log(`     P${o.priority}: ${(o.content || "").substring(0, 50)}...`);
      });
    }
    if (!DRY_RUN && orphans && orphans.length > 0) {
      const ids = orphans.map(o => o.id);
      const { error: updateErr } = await supabase
        .from("memory")
        .update({ status: "archived", metadata: { archived_reason: "orphan_cleanup", archived_at: new Date().toISOString() } })
        .in("id", ids);
      if (updateErr) {
        console.log("   Error archiving:", updateErr.message);
      } else {
        console.log(`   Archived: ${ids.length} orphan actions`);
      }
    }
  }
  console.log("");

  // 3. Check for excessive action counts per goal
  console.log("3. ACTION COUNTS BY PARENT:");
  const { data: allActions, error: actionsErr } = await supabase
    .from("memory")
    .select("parent_id")
    .eq("type", "action")
    .eq("status", "pending");

  if (actionsErr) {
    console.log("   Error:", actionsErr.message);
  } else if (allActions) {
    const counts: Record<string, number> = {};
    allActions.forEach(a => {
      const pid = a.parent_id || "orphan";
      counts[pid] = (counts[pid] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    console.log("   Top 5 goals by action count:");
    sorted.slice(0, 5).forEach(([pid, count]) => {
      console.log(`     ${pid.substring(0, 8)}...: ${count} actions`);
    });
  }
  console.log("");

  // 4. Final stats
  console.log("4. FINAL STATS:");
  const { count: totalPending } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  const { count: totalActive } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");

  const { count: totalArchived } = await supabase
    .from("memory")
    .select("*", { count: "exact", head: true })
    .eq("status", "archived");

  console.log(`   Pending: ${totalPending}`);
  console.log(`   Active: ${totalActive}`);
  console.log(`   Archived: ${totalArchived}`);

  if (DRY_RUN) {
    console.log("\n   Run with --force to apply changes");
  }
}

cleanup().catch(console.error);
