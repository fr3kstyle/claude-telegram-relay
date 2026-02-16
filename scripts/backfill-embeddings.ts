#!/usr/bin/env bun
/**
 * Backfill missing embeddings in global_memory table
 * Calls the Supabase Edge Function to generate embeddings via OpenAI
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function backfillEmbeddings() {
  console.log("Fetching items without embeddings...\n");

  const { data: noEmb, error } = await supabase
    .from("global_memory")
    .select("id, content")
    .is("embedding", null);

  if (error) {
    console.error("Error fetching:", error.message);
    return;
  }

  console.log("Found " + (noEmb?.length || 0) + " items without embeddings\n");

  if (!noEmb || noEmb.length === 0) {
    console.log("Nothing to backfill");
    return;
  }

  const functionUrl = SUPABASE_URL + "/functions/v1/embed";
  let successCount = 0;
  let failCount = 0;

  for (const item of noEmb) {
    try {
      const response = await fetch(functionUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: item.id, content: item.content }),
      });

      const result = await response.json();
      if (response.ok) {
        successCount++;
        console.log("OK: " + item.content?.substring(0, 50));
      } else {
        failCount++;
        console.log("FAIL: " + item.content?.substring(0, 50) + " - " + (result.error || result.message));
      }
    } catch (err) {
      failCount++;
      console.log("ERROR: " + err);
    }

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("\n=== BACKFILL COMPLETE ===");
  console.log("Success: " + successCount);
  console.log("Failed: " + failCount);
}

backfillEmbeddings().catch(console.error);
