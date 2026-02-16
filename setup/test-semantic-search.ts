/**
 * Test Search Functions
 *
 * Diagnoses semantic and text search availability.
 * Run: bun run setup/test-semantic-search.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

async function main() {
  console.log("=== Search Diagnostics ===\n");

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("❌ Missing SUPABASE_URL or SUPABASE_KEY");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Database connection
  console.log("1. Database: ");
  try {
    await supabase.from("global_memory").select("id").limit(1);
    console.log("   ✅ Connected\n");
  } catch (e) {
    console.log("   ❌ Failed:", e);
    process.exit(1);
  }

  // 2. Edge Function (semantic search)
  console.log("2. Semantic Search (Edge Function):");
  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query: "test", match_count: 3 },
    });
    if (error) {
      console.log("   ❌ Error:", error.message);
      console.log("   → Set OPENAI_API_KEY: supabase secrets set OPENAI_API_KEY=sk-...");
    } else {
      console.log("   ✅ Working:", data?.results?.length || 0, "results");
    }
  } catch (e) {
    console.log("   ❌ Unreachable:", e);
  }
  console.log();

  // 3. Text Search RPC (fallback)
  console.log("3. Text Search (RPC Fallback):");
  try {
    const { data, error } = await supabase.rpc("search_memory_text", {
      search_query: "agent",
      match_count: 5,
    });
    if (error) {
      console.log("   ⚠️  RPC not found - run migration 20260216120000_direct_search_fallback.sql");
    } else {
      console.log("   ✅ Working:", data?.length || 0, "results");
      if (data?.length > 0) {
        console.log("   Sample:", data[0].content?.substring(0, 50) + "...");
      }
    }
  } catch (e) {
    console.log("   ❌ Error:", e);
  }
  console.log();

  // 4. Simple ILIKE fallback
  console.log("4. Simple ILIKE Search:");
  try {
    const { data, error } = await supabase
      .from("global_memory")
      .select("content, type")
      .ilike("content", "%agent%")
      .limit(3);
    if (error) throw error;
    console.log("   ✅ Working:", data?.length || 0, "results");
  } catch (e) {
    console.log("   ❌ Error:", e);
  }
  console.log();

  // 5. Memory count
  console.log("5. Memory Stats:");
  try {
    const { count: total } = await supabase.from("global_memory").select("*", { count: "exact", head: true });
    const { data: withEmb } = await supabase.from("global_memory").select("id").not("embedding", "is", null);
    console.log(`   Total memories: ${total || 0}`);
    console.log(`   With embeddings: ${withEmb?.length || 0}`);
  } catch (e) {
    console.log("   Error:", e);
  }

  console.log("\n=== Status ===");
  console.log("Search will work with fallbacks even if semantic search fails.");
}

main().catch(console.error);
