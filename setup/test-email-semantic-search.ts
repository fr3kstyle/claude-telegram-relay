/**
 * Test Email Semantic Search
 *
 * Verifies that semantic search is working on email_messages.
 *
 * Usage: bun run setup/test-email-semantic-search.ts "your search query"
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
);

const openaiKey = process.env.OPENAI_API_KEY;

async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!openaiKey) {
    console.error("OPENAI_API_KEY not set");
    return null;
  }

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
    const err = await response.text();
    console.error("OpenAI error:", response.status, err);
    return null;
  }

  const data = await response.json();
  return data.data[0].embedding;
}

async function testSearch() {
  const query = process.argv[2] || "meeting or project discussion";

  console.log("=== Email Semantic Search Test ===\n");
  console.log("Query:", query);
  console.log();

  const embedding = await generateEmbedding(query);
  if (!embedding) {
    process.exit(1);
  }

  // Search using RPC
  const { data: results, error } = await supabase.rpc("search_emails_semantic", {
    p_query_embedding: embedding,
    p_match_threshold: 0.3,
    p_match_count: 5,
  });

  if (error) {
    console.error("Search error:", error.message);
    process.exit(1);
  }

  if (!results || results.length === 0) {
    console.log("No results found. Try lowering the threshold or using different terms.");
    return;
  }

  console.log(`Found ${results.length} results:\n`);

  results.forEach((r: any, i: number) => {
    console.log(`${i + 1}. ${r.subject?.substring(0, 60) || "(no subject)"}`);
    console.log(`   From: ${r.from_email}`);
    console.log(`   Date: ${r.date}`);
    console.log(`   Similarity: ${r.similarity?.toFixed(3)}`);
    console.log(`   Snippet: ${r.snippet?.substring(0, 100)}...`);
    console.log();
  });
}

testSearch().catch(console.error);
