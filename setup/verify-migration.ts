/**
 * Verify Autonomous Agent Migration
 *
 * Checks that all required components are in place.
 * Run: bun run setup/verify-migration.ts
 */

import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  console.log("=".repeat(50));
  console.log("Autonomous Agent Migration Verification");
  console.log("=".repeat(50));

  const results: { component: string; status: "ok" | "missing" | "error"; detail?: string }[] = [];

  // Test columns
  console.log("\n[1] Testing global_memory columns...");
  const { error: colError } = await supabase
    .from("global_memory")
    .select("id,metadata,retry_count,last_error")
    .limit(1);

  if (colError) {
    results.push({ component: "metadata column", status: "missing", detail: colError.message });
    console.log("  ❌ metadata column: missing");
  } else {
    results.push({ component: "metadata column", status: "ok" });
    console.log("  ✅ metadata column: ok");
  }

  // Test RPCs
  console.log("\n[2] Testing RPC functions...");
  const rpcs = [
    { name: "get_pending_actions", params: {} },
    { name: "get_strategies", params: {} },
    { name: "get_reflections", params: { limit_count: 5 } },
    { name: "get_agent_state", params: {} },
    { name: "mark_action_blocked", params: { p_id: "00000000-0000-0000-0000-000000000000", p_error: "test" }, skipCheck: true },
    { name: "mark_action_completed", params: { p_id: "00000000-0000-0000-0000-000000000000" }, skipCheck: true },
    { name: "complete_goal_cascade", params: { goal_id: "00000000-0000-0000-0000-000000000000" }, skipCheck: true },
    { name: "block_goal", params: { goal_id: "00000000-0000-0000-0000-000000000000", reason: "test" }, skipCheck: true },
    { name: "decompose_goal", params: { parent_goal_id: "00000000-0000-0000-0000-000000000000", item_type: "action", item_content: "test" }, skipCheck: true },
    { name: "log_system_event", params: { event_content: "test", event_metadata: {} } },
  ];

  for (const rpc of rpcs) {
    try {
      const { error } = await supabase.rpc(rpc.name as any, rpc.params as any);
      if (error && error.code === "PGRST202") {
        results.push({ component: `${rpc.name}()`, status: "missing" });
        console.log(`  ❌ ${rpc.name}(): missing`);
      } else {
        results.push({ component: `${rpc.name}()`, status: "ok" });
        console.log(`  ✅ ${rpc.name}(): ok`);
      }
    } catch (e) {
      results.push({ component: `${rpc.name}()`, status: "error", detail: String(e) });
      console.log(`  ⚠️  ${rpc.name}(): error`);
    }
  }

  // Test agent_loop_state table
  console.log("\n[3] Testing agent_loop_state table...");
  const { error: tableError } = await supabase
    .from("agent_loop_state")
    .select("*")
    .limit(1);

  if (tableError) {
    results.push({ component: "agent_loop_state table", status: "missing", detail: tableError.message });
    console.log("  ❌ agent_loop_state table: missing");
  } else {
    results.push({ component: "agent_loop_state table", status: "ok" });
    console.log("  ✅ agent_loop_state table: ok");
  }

  // Test memory view
  console.log("\n[4] Testing memory view...");
  const { error: viewError } = await supabase
    .from("memory")
    .select("*")
    .limit(1);

  if (viewError) {
    results.push({ component: "memory view", status: "missing", detail: viewError.message });
    console.log("  ❌ memory view: missing");
  } else {
    results.push({ component: "memory view", status: "ok" });
    console.log("  ✅ memory view: ok");
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  const ok = results.filter(r => r.status === "ok").length;
  const missing = results.filter(r => r.status === "missing").length;
  const errors = results.filter(r => r.status === "error").length;

  console.log(`Summary: ${ok} ok, ${missing} missing, ${errors} errors`);

  if (missing > 0) {
    console.log("\n⚠️  Migration incomplete. Apply setup/migration-partial.sql via Supabase Dashboard.");
  } else {
    console.log("\n✅ All components verified!");
  }
}

main().catch(console.error);
