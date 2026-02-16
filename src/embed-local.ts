/**
 * Local Embedding Service
 * 
 * Generates embeddings locally using OpenAI API (via .env)
 * This bypasses the need for Edge Functions when they're not deployed.
 * 
 * Can be called directly by the relay for search.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

/**
 * Generate embedding for text using OpenAI
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_KEY) {
    console.error("[Embed] No OPENAI_API_KEY set");
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.substring(0, 8000), // Truncate to avoid limits
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[Embed] OpenAI API error:", err);
      return null;
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error("[Embed] Error:", e);
    return null;
  }
}

/**
 * Search memory using embeddings (local, no Edge Function needed)
 */
export async function searchMemoryLocal(
  query: string,
  matchCount: number = 10,
  matchThreshold: number = 0.6
): Promise<Array<{ content: string; type: string; similarity: number }>> {
  if (!supabase) return [];

  const embedding = await generateEmbedding(query);
  if (!embedding) {
    // Fallback to text search
    return searchTextLocal(query, matchCount);
  }

  try {
    // Try match_memory RPC
    const { data, error } = await supabase.rpc("match_memory", {
      query_embedding: embedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (!error && data && data.length > 0) {
      return data;
    }

    // Fallback to text search if no semantic results
    return searchTextLocal(query, matchCount);
  } catch (e) {
    console.error("[Embed] Search error:", e);
    return searchTextLocal(query, matchCount);
  }
}

/**
 * Simple text search fallback
 */
async function searchTextLocal(
  query: string,
  limit: number = 10
): Promise<Array<{ content: string; type: string; similarity: number }>> {
  if (!supabase) return [];

  const words = query.split(" ").filter(w => w.length > 2).slice(0, 3);
  const results: Array<{ content: string; type: string; similarity: number }> = [];
  const seen = new Set<string>();

  // Search global_memory table
  try {
    const word = words[0] || query;
    const { data } = await supabase
      .from("global_memory")
      .select("content, type")
      .ilike("content", `%${word}%`)
      .in("type", ["fact", "goal", "strategy", "preference"])
      .limit(limit);

    if (data) {
      for (const r of data) {
        const key = r.content.substring(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ content: r.content, type: r.type, similarity: 0.4 });
        }
      }
    }
  } catch (e) {
    // Ignore
  }

  return results.slice(0, limit);
}

/**
 * Backfill embeddings for memories without them
 */
export async function backfillEmbeddings(batchSize: number = 10): Promise<number> {
  if (!supabase || !OPENAI_KEY) {
    console.error("[Embed] Cannot backfill: missing supabase or OPENAI_KEY");
    return 0;
  }

  // Get memories without embeddings from global_memory
  const { data: memories } = await supabase
    .from("global_memory")
    .select("id, content")
    .is("embedding", null)
    .limit(batchSize);

  let count = 0;

  if (memories && memories.length > 0) {
    for (const mem of memories) {
      const embedding = await generateEmbedding(mem.content);
      if (embedding) {
        await supabase
          .from("global_memory")
          .update({ embedding })
          .eq("id", mem.id);
        count++;
        console.log(`[Embed] Backfilled: ${mem.content.substring(0, 50)}...`);
      }
    }
  }

  return count;
}

// CLI usage
if (import.meta.main) {
  const command = process.argv[2];

  if (command === "backfill") {
    console.log("[Embed] Starting backfill...");
    const count = await backfillEmbeddings(50);
    console.log(`[Embed] Backfilled ${count} memories`);
  } else if (command === "test") {
    const query = process.argv[3] || "test query";
    console.log(`[Embed] Testing search: "${query}"`);
    const results = await searchMemoryLocal(query);
    console.log(`[Embed] Found ${results.length} results:`);
    results.forEach(r => console.log(`  - [${r.type}] ${r.content.substring(0, 60)}...`));
  } else {
    console.log("Usage:");
    console.log("  bun src/embed-local.ts backfill  - Backfill embeddings");
    console.log("  bun src/embed-local.ts test 'query' - Test search");
  }
}
