import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
);

const openaiKey = process.env.OPENAI_API_KEY;

async function testEmbedding() {
  console.log("=== Testing OpenAI Embeddings ===");
  console.log("API Key found:", openaiKey ? "YES" : "NO");

  if (!openaiKey) {
    console.log("ERROR: No OpenAI API key in environment");
    return;
  }

  // Test OpenAI API directly
  console.log("\nTesting OpenAI API...");
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + openaiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: "test query for semantic search",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.log("ERROR:", response.status, err);
    return;
  }

  const data = await response.json();
  console.log("SUCCESS: Got embedding with", data.data[0].embedding.length, "dimensions");

  // Test match_memory RPC
  console.log("\nTesting match_memory RPC...");
  const embedding = data.data[0].embedding;

  const { data: matches, error: rpcErr } = await supabase.rpc("match_memory", {
    query_embedding: embedding,
    match_threshold: 0.5,
    match_count: 5,
  });

  if (rpcErr) {
    console.log("RPC error:", rpcErr.message);
  } else {
    console.log("SUCCESS: match_memory RPC returned", matches?.length || 0, "results");
  }

  // Check how many memories have embeddings
  const { data: withEmb } = await supabase
    .from("memory")
    .select("id")
    .not("embedding", "is", null);

  const { data: withoutEmb } = await supabase
    .from("memory")
    .select("id")
    .is("embedding", null);

  console.log("\nMemory embedding status:");
  console.log("  With embeddings:", withEmb?.length || 0);
  console.log("  Without embeddings:", withoutEmb?.length || 0);
}

testEmbedding().catch(console.error);
