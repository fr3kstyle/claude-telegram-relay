/**
 * Backfill Email Embeddings
 *
 * Generates embeddings for all email_messages that don't have them yet.
 * Uses OpenAI text-embedding-3-small model.
 *
 * Usage: bun run setup/backfill-email-embeddings.ts
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
);

const openaiKey = process.env.OPENAI_API_KEY;

const BATCH_SIZE = 20; // OpenAI allows up to 2048 inputs per request
const MAX_TEXT_LENGTH = 8000; // Truncate to avoid token limits

function prepareEmailText(email: {
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  snippet: string | null;
  body_text: string | null;
}): string {
  // Combine subject, sender, and body for rich semantic search
  const parts = [
    email.subject || "",
    `From: ${email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email || ""}`,
    email.body_text || email.snippet || "",
  ];

  const text = parts.join("\n\n");
  // Truncate if too long
  return text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;
}

async function generateEmbeddings(texts: string[]): Promise<number[][] | null> {
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
  console.log("=== Email Embedding Backfill ===\n");

  if (!openaiKey) {
    console.error("ERROR: OPENAI_API_KEY environment variable not set");
    console.error("Set it with: export OPENAI_API_KEY=sk-...");
    process.exit(1);
  }

  // Get emails without embeddings
  const { data: emails, error } = await supabase
    .from("email_messages")
    .select("id, subject, from_email, from_name, snippet, body_text")
    .is("embedding", null)
    .order("date", { ascending: false });

  if (error) {
    console.error("Error fetching emails:", error);
    process.exit(1);
  }

  if (!emails || emails.length === 0) {
    console.log("All emails already have embeddings!");
    return;
  }

  console.log(`Found ${emails.length} emails without embeddings\n`);

  let processed = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    const texts = batch.map(prepareEmailText);

    console.log(
      `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(emails.length / BATCH_SIZE)} (${batch.length} items)...`
    );

    const embeddings = await generateEmbeddings(texts);

    if (!embeddings) {
      console.error("  Failed to generate embeddings for batch");
      failed += batch.length;
      continue;
    }

    // Update each email with its embedding
    for (let j = 0; j < batch.length; j++) {
      const { error: updateErr } = await supabase
        .from("email_messages")
        .update({ embedding: embeddings[j] })
        .eq("id", batch[j].id);

      if (updateErr) {
        console.error(`  Failed to update ${batch[j].id}:`, updateErr.message);
        failed++;
      } else {
        processed++;
      }
    }

    console.log(`  Updated ${batch.length} emails`);
  }

  console.log(`\n=== Complete ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Failed: ${failed}`);

  // Verify
  const { data: withEmb } = await supabase
    .from("email_messages")
    .select("id")
    .not("embedding", "is", null);

  console.log(`\nEmails with embeddings: ${withEmb?.length || 0}`);
}

backfill().catch(console.error);
