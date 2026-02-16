#!/usr/bin/env bun
/**
 * Goal Hygiene Cleanup Script
 *
 * Analyzes and cleans up the global_memory table:
 * - Finds duplicates, stale items, malformed entries
 * - Archives stale items (older than 7 days)
 * - Deletes malformed entries
 * - Reports action-to-goal ratio
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DAYS_STALE = 7;
const DRY_RUN = process.argv.includes("--dry-run") || !process.argv.includes("--execute");

interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  status: string;
  priority: number | null;
  created_at: string;
  updated_at: string;
  parent_id: string | null;
}

// Which table to use - 'memory' is the main one with 800+ items
const TABLE = "memory";

async function analyzeMemory() {
  console.log("\n=== GOAL HYGIENE ANALYSIS ===\n");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "EXECUTE (will make changes)"}\n`);
  console.log(`Target table: ${TABLE}\n`);

  // 1. Get counts
  const { count: totalGoals } = await supabase
    .from(TABLE)
    .select("*", { count: "exact", head: true })
    .eq("type", "goal")
    .eq("status", "active");

  const { count: totalActions } = await supabase
    .from(TABLE)
    .select("*", { count: "exact", head: true })
    .eq("type", "action")
    .eq("status", "pending");

  const { count: totalBlocked } = await supabase
    .from(TABLE)
    .select("*", { count: "exact", head: true })
    .eq("status", "blocked");

  const { count: totalArchived } = await supabase
    .from(TABLE)
    .select("*", { count: "exact", head: true })
    .eq("status", "archived");

  console.log("=== SUMMARY ===");
  console.log(`Active Goals: ${totalGoals}`);
  console.log(`Pending Actions: ${totalActions}`);
  console.log(`Blocked Items: ${totalBlocked}`);
  console.log(`Archived Items: ${totalArchived}`);
  console.log(`Action:Goal Ratio: ${totalActions && totalGoals ? (totalActions / totalGoals).toFixed(1) : 0}:1`);
  console.log(`Health Status: ${totalActions && totalGoals && totalActions / totalGoals > 10 ? "UNHEALTHY (>10:1)" : "OK"}`);

  // 2. Find duplicates
  const { data: allGoals } = await supabase
    .from(TABLE)
    .select("id, content, created_at")
    .eq("type", "goal")
    .eq("status", "active")
    .order("created_at", { ascending: false });

  const duplicates: Map<string, MemoryEntry[]> = new Map();
  if (allGoals) {
    for (const goal of allGoals) {
      const key = goal.content.toLowerCase().substring(0, 50);
      if (!duplicates.has(key)) duplicates.set(key, []);
      duplicates.get(key)!.push(goal as unknown as MemoryEntry);
    }
  }

  const duplicateGroups = Array.from(duplicates.entries()).filter(([_, v]) => v.length > 1);
  console.log(`\n=== DUPLICATES (${duplicateGroups.length} groups) ===`);
  for (const [key, entries] of duplicateGroups.slice(0, 10)) {
    console.log(`  "${key}..." - ${entries.length} copies`);
  }

  // 3. Find stale items
  const staleDate = new Date(Date.now() - DAYS_STALE * 24 * 60 * 60 * 1000).toISOString();
  const { data: staleItems } = await supabase
    .from(TABLE)
    .select("id, type, content, updated_at")
    .in("status", ["active", "pending"])
    .lt("updated_at", staleDate)
    .order("updated_at", { ascending: true })
    .limit(50);

  console.log(`\n=== STALE ITEMS (> ${DAYS_STALE} days old) ===`);
  console.log(`Found: ${staleItems?.length || 0} items`);
  if (staleItems && staleItems.length > 0) {
    for (const item of staleItems.slice(0, 10)) {
      const daysOld = Math.floor((Date.now() - new Date(item.updated_at).getTime()) / (24 * 60 * 60 * 1000));
      console.log(`  [${item.type}] ${item.content.substring(0, 60)}... (${daysOld} days old)`);
    }
  }

  // 4. Find malformed entries
  const { data: malformed } = await supabase
    .from(TABLE)
    .select("id, type, content")
    .or("content.is.null,content.eq.,content.like.]`%,content.like.%`[%");

  console.log(`\n=== MALFORMED ENTRIES ===`);
  console.log(`Found: ${malformed?.length || 0} items`);
  if (malformed && malformed.length > 0) {
    for (const item of malformed) {
      console.log(`  [${item.id}] "${item.content?.substring(0, 40) || "NULL"}"`);
    }
  }

  // 5. Find email-related goals (to consolidate)
  const { data: emailGoals } = await supabase
    .from("global_memory")
    .select("id, content, priority, created_at")
    .eq("type", "goal")
    .eq("status", "active")
    .or("content.ilike.%email%,content.ilike.%gmail%,content.ilike.%imap%,content.ilike.%oauth%")
    .order("created_at", { ascending: true });

  console.log(`\n=== EMAIL-RELATED GOALS (need consolidation) ===`);
  console.log(`Found: ${emailGoals?.length || 0} goals`);
  if (emailGoals && emailGoals.length > 0) {
    for (const goal of emailGoals.slice(0, 15)) {
      console.log(`  [P${goal.priority || "?"}] ${goal.content.substring(0, 70)}...`);
    }
    if (emailGoals.length > 15) {
      console.log(`  ... and ${emailGoals.length - 15} more`);
    }
  }

  // 6. Find actions older than 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: expiredActions } = await supabase
    .from("global_memory")
    .select("id, content, created_at")
    .eq("type", "action")
    .eq("status", "pending")
    .lt("created_at", oneDayAgo)
    .is("parent_id", null);

  console.log(`\n=== EXPIRED ACTIONS (> 24h old, no parent) ===`);
  console.log(`Found: ${expiredActions?.length || 0} actions`);

  return {
    totalGoals,
    totalActions,
    duplicateGroups,
    staleItems,
    malformed,
    emailGoals,
    expiredActions,
  };
}

async function executeCleanup(analysis: Awaited<ReturnType<typeof analyzeMemory>>) {
  if (DRY_RUN) {
    console.log("\n=== DRY RUN COMPLETE ===");
    console.log("Run with --execute to apply changes");
    return;
  }

  console.log("\n=== EXECUTING CLEANUP ===\n");
  let archived = 0;
  let deleted = 0;

  // 1. Archive stale items
  if (analysis.staleItems && analysis.staleItems.length > 0) {
    const staleIds = analysis.staleItems.map((i) => i.id);
    const { error } = await supabase
      .from("global_memory")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .in("id", staleIds);
    if (error) console.error("Error archiving stale items:", error.message);
    else {
      archived += staleIds.length;
      console.log(`Archived ${staleIds.length} stale items`);
    }
  }

  // 2. Delete malformed entries
  if (analysis.malformed && analysis.malformed.length > 0) {
    const malformedIds = analysis.malformed.map((i) => i.id);
    const { error } = await supabase.from("global_memory").delete().in("id", malformedIds);
    if (error) console.error("Error deleting malformed entries:", error.message);
    else {
      deleted += malformedIds.length;
      console.log(`Deleted ${malformedIds.length} malformed entries`);
    }
  }

  // 3. Delete expired actions
  if (analysis.expiredActions && analysis.expiredActions.length > 0) {
    const expiredIds = analysis.expiredActions.map((i) => i.id);
    const { error } = await supabase.from("global_memory").delete().in("id", expiredIds);
    if (error) console.error("Error deleting expired actions:", error.message);
    else {
      deleted += expiredIds.length;
      console.log(`Deleted ${expiredIds.length} expired actions`);
    }
  }

  // 4. Archive duplicate goals (keep newest)
  if (analysis.duplicateGroups && analysis.duplicateGroups.length > 0) {
    for (const [_, entries] of analysis.duplicateGroups) {
      // Keep first (newest), archive rest
      const toArchive = entries.slice(1).map((e) => e.id);
      if (toArchive.length > 0) {
        const { error } = await supabase
          .from("global_memory")
          .update({ status: "archived", updated_at: new Date().toISOString() })
          .in("id", toArchive);
        if (error) console.error("Error archiving duplicates:", error.message);
        else {
          archived += toArchive.length;
          console.log(`Archived ${toArchive.length} duplicate goals for "${entries[0].content.substring(0, 30)}..."`);
        }
      }
    }
  }

  console.log(`\n=== CLEANUP COMPLETE ===`);
  console.log(`Total archived: ${archived}`);
  console.log(`Total deleted: ${deleted}`);
}

async function main() {
  const analysis = await analyzeMemory();
  await executeCleanup(analysis);
}

main().catch(console.error);
