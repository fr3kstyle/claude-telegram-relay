/**
 * Fix Embeddings - Use proper vector format
 *
 * The embeddings were stored as strings instead of vectors.
 * This script re-inserts them with proper vector format.
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const openaiKey = process.env.OPENAI_API_KEY;

async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!openaiKey) return null;

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + openaiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (!response.ok) {
    console.error("OpenAI error:", response.status);
    return null;
  }

  const data = await response.json();
  return data.data[0].embedding;
}

async function fixEmbeddings() {
  console.log("=== Fixing Embeddings ===\n");

  // First, clear existing string embeddings
  const { error: clearErr } = await supabase
    .from("memory")
    .update({ embedding: null })
    .not("embedding", "is", null);

  if (clearErr) {
    console.log("Clear error:", clearErr.message);
  } else {
    console.log("Cleared existing embeddings");
  }

  // Get all memories
  const { data: memories, error } = await supabase
    .from("memory")
    .select("id, content, type")
    .order("created_at", { ascending: false });

  if (error || !memories) {
    console.error("Error fetching memories:", error);
    return;
  }

  console.log(`Processing ${memories.length} memories...\n`);

  let processed = 0;
  let failed = 0;

  for (const mem of memories) {
    const embedding = await generateEmbedding(mem.content);

    if (!embedding) {
      console.log(`  Failed: ${mem.content.substring(0, 30)}...`);
      failed++;
      continue;
    }

    // Use raw update with proper vector cast
    const vectorStr = "[" + embedding.join(",") + "]";

    const { error: updateErr } = await supabase
      .rpc("update_memory_embedding", {
        p_id: mem.id,
        p_embedding: vectorStr
      });

    if (updateErr) {
      // If RPC doesn't exist, try direct update
      const { error: directErr } = await supabase
        .from("memory")
        .update({ embedding: vectorStr })
        .eq("id", mem.id);

      if (directErr) {
        console.log(`  Error: ${mem.content.substring(0, 30)}... - ${directErr.message}`);
        failed++;
      } else {
        processed++;
      }
    } else {
      processed++;
    }
  }

  console.log(`\n=== Complete ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Failed: ${failed}`);

  // Verify
  const { data: testMem } = await supabase
    .from("memory")
    .select("id, content, embedding")
    .not("embedding", "is", null)
    .limit(1)
    .single();

  console.log("\nVerification:");
  console.log("  Embedding type:", typeof testMem?.embedding);
  console.log("  Is array:", Array.isArray(testMem?.embedding));
}

fixEmbeddings().catch(console.error);
