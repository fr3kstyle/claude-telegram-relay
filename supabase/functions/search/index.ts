import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseKey);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const query = body.query;
    const matchCount = body.match_count ?? 10;
    const matchThreshold = body.match_threshold ?? 0.6; // Lower threshold for better recall
    const table = body.table ?? "global_memory"; // Support both tables

    if (!query || typeof query !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid query parameter" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check for OpenAI key
    if (!openaiKey) {
      console.error("OPENAI_API_KEY not configured");
      return new Response(
        JSON.stringify({ results: [], error: "OpenAI API key not configured" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generate embedding for the query
    const embeddingResponse = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: query,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      console.error("OpenAI API error:", err);
      return new Response(
        JSON.stringify({ results: [], error: "OpenAI API error", details: err }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data?.[0]?.embedding;

    if (!queryEmbedding) {
      return new Response(
        JSON.stringify({ results: [], error: "No embedding returned" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Try unified search first (searches both tables)
    let data, error;

    // Try match_memory_unified for best results
    const unifiedResult = await supabase.rpc("match_memory_unified", {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (!unifiedResult.error && unifiedResult.data && unifiedResult.data.length > 0) {
      data = unifiedResult.data;
      error = null;
    } else {
      // Fallback to original match_memory
      const fallbackResult = await supabase.rpc("match_memory", {
        query_embedding: queryEmbedding,
        match_threshold: matchThreshold,
        match_count: matchCount,
      });
      data = fallbackResult.data;
      error = fallbackResult.error;
    }

    if (error) {
      console.error("Search RPC error:", error);

      // Last resort: direct table query
      const directQuery = await supabase
        .from(table)
        .select("id, content, type")
        .not("embedding", "is", null)
        .textSearch("content", query.split(" ").join(" | "), { type: "websearch" })
        .limit(matchCount);

      if (directQuery.data && directQuery.data.length > 0) {
        return new Response(
          JSON.stringify({
            results: directQuery.data.map(r => ({ ...r, similarity: 0.5 })),
            fallback: true,
            method: "text_search"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ results: [], error: error.message }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ results: data || [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Search function error:", err);
    return new Response(
      JSON.stringify({ results: [], error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
});
