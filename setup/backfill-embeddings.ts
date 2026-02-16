/**
 * Backfill Embeddings
 *
 * Generates embeddings for all memories that don't have them yet.
 * Uses OpenAI text-embedding-3-small model.
 *
 * Usage: bun run setup/backfill-embeddings.ts
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
);

const openaiKey = process.env.OPENAI_API_KEY;

const BATCH_SIZE = 20; // OpenAI allows up to 2048 inputs per request

async function generateEmbeddings(texts: string[]): Promise<number[][] | null> {
  if (!openaiKey) return null;

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + openaiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("OpenAI error:", response.status, err);
    return null;
  }

  const data = await response.json();
  return data.data.map((d: any) => d.embedding);
}

async function backfill() {
  console.log("=== Embedding Backfill ===\n");

  // Get memories without embeddings
  const { data: memories, error } = await supabase
    .from("memory")
    .select("id, content, type")
    .is("embedding", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching memories:", error);
    return;
  }

  if (!memories || memories.length === 0) {
    console.log("All memories already have embeddings!");
    return;
  }

  console.log(`Found ${memories.length} memories without embeddings\n`);

  let processed = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    const texts = batch.map((m) => m.content);

    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} items)...`);

    const embeddings = await generateEmbeddings(texts);

    if (!embeddings) {
      console.error("  Failed to generate embeddings for batch");
      failed += batch.length;
      continue;
    }

    // Update each memory with its embedding
    for (let j = 0; j < batch.length; j++) {
      const { error: updateErr } = await supabase
        .from("memory")
        .update({ embedding: embeddings[j] })
        .eq("id", batch[j].id);

      if (updateErr) {
        console.error(`  Failed to update ${batch[j].id}:`, updateErr.message);
        failed++;
      } else {
        processed++;
      }
    }

    console.log(`  Updated ${batch.length} memories`);
  }

  console.log(`\n=== Complete ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Failed: ${failed}`);

  // Verify
  const { data: withEmb } = await supabase
    .from("memory")
    .select("id")
    .not("embedding", "is", null);

  console.log(`\nMemories with embeddings: ${withEmb?.length || 0}`);
}

backfill().catch(console.error);
