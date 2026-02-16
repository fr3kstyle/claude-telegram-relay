#!/usr/bin/env bun
/**
 * Apply OAuth tokens migration via Supabase
 * Creates the oauth_tokens table and related RPCs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// Individual SQL statements to apply (split from migration file)
const statements = [
  // Table creation
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'github', 'custom')),
    email TEXT NOT NULL,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    token_expiry TIMESTAMPTZ,
    scopes JSONB DEFAULT '[]',
    token_metadata JSONB DEFAULT '{}',
    is_valid BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(provider, email)
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider_email ON oauth_tokens(provider, email)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_valid ON oauth_tokens(is_valid) WHERE is_valid = true`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(token_expiry) WHERE token_expiry IS NOT NULL`,

  // get_oauth_token RPC
  `CREATE OR REPLACE FUNCTION get_oauth_token(p_provider TEXT, p_email TEXT)
   RETURNS oauth_tokens AS $$
   DECLARE tok oauth_tokens%ROWTYPE;
   BEGIN SELECT * INTO tok FROM oauth_tokens WHERE provider = p_provider AND email = p_email LIMIT 1; RETURN tok; END;
   $$ LANGUAGE plpgsql`,

  // get_valid_oauth_tokens RPC
  `CREATE OR REPLACE FUNCTION get_valid_oauth_tokens(p_provider TEXT)
   RETURNS SETOF oauth_tokens AS $$
   BEGIN RETURN QUERY SELECT * FROM oauth_tokens WHERE provider = p_provider AND is_valid = true AND (token_expiry IS NULL OR token_expiry > NOW()) ORDER BY email; END;
   $$ LANGUAGE plpgsql`,

  // get_tokens_expiring_soon RPC
  `CREATE OR REPLACE FUNCTION get_tokens_expiring_soon(p_within_hours INT DEFAULT 1)
   RETURNS SETOF oauth_tokens AS $$
   BEGIN RETURN QUERY SELECT * FROM oauth_tokens WHERE is_valid = true AND token_expiry IS NOT NULL AND token_expiry <= NOW() + (p_within_hours || ' hours')::interval AND token_expiry > NOW() ORDER BY token_expiry ASC; END;
   $$ LANGUAGE plpgsql`,

  // update_oauth_token RPC
  `CREATE OR REPLACE FUNCTION update_oauth_token(p_provider TEXT, p_email TEXT, p_access_token_encrypted TEXT, p_refresh_token_encrypted TEXT DEFAULT NULL, p_token_expiry TIMESTAMPTZ DEFAULT NULL, p_scopes JSONB DEFAULT NULL)
   RETURNS oauth_tokens AS $$
   DECLARE tok oauth_tokens%ROWTYPE;
   BEGIN UPDATE oauth_tokens SET access_token_encrypted = p_access_token_encrypted, refresh_token_encrypted = COALESCE(p_refresh_token_encrypted, refresh_token_encrypted), token_expiry = p_token_expiry, scopes = COALESCE(p_scopes, scopes), is_valid = true, error_count = 0, last_error = NULL, updated_at = NOW() WHERE provider = p_provider AND email = p_email RETURNING * INTO tok; RETURN tok; END;
   $$ LANGUAGE plpgsql`,

  // record_token_usage RPC
  `CREATE OR REPLACE FUNCTION record_token_usage(p_provider TEXT, p_email TEXT)
   RETURNS VOID AS $$
   BEGIN UPDATE oauth_tokens SET last_used_at = NOW(), updated_at = NOW() WHERE provider = p_provider AND email = p_email; END;
   $$ LANGUAGE plpgsql`,

  // record_token_error RPC
  `CREATE OR REPLACE FUNCTION record_token_error(p_provider TEXT, p_email TEXT, p_error TEXT, p_invalidate BOOLEAN DEFAULT false)
   RETURNS VOID AS $$
   BEGIN UPDATE oauth_tokens SET error_count = error_count + 1, last_error = p_error, is_valid = CASE WHEN p_invalidate THEN false ELSE is_valid END, updated_at = NOW() WHERE provider = p_provider AND email = p_email; END;
   $$ LANGUAGE plpgsql`,

  // upsert_oauth_token RPC (the one we need most)
  `CREATE OR REPLACE FUNCTION upsert_oauth_token(p_provider TEXT, p_email TEXT, p_access_token_encrypted TEXT, p_refresh_token_encrypted TEXT DEFAULT NULL, p_token_expiry TIMESTAMPTZ DEFAULT NULL, p_scopes JSONB DEFAULT '[]'::jsonb, p_metadata JSONB DEFAULT '{}'::jsonb)
   RETURNS oauth_tokens AS $$
   DECLARE tok oauth_tokens%ROWTYPE;
   BEGIN INSERT INTO oauth_tokens (provider, email, access_token_encrypted, refresh_token_encrypted, token_expiry, scopes, token_metadata)
   VALUES (p_provider, p_email, p_access_token_encrypted, p_refresh_token_encrypted, p_token_expiry, p_scopes, p_metadata)
   ON CONFLICT (provider, email) DO UPDATE SET
     access_token_encrypted = EXCLUDED.access_token_encrypted,
     refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, oauth_tokens.refresh_token_encrypted),
     token_expiry = EXCLUDED.token_expiry,
     scopes = EXCLUDED.scopes,
     token_metadata = EXCLUDED.token_metadata,
     is_valid = true, error_count = 0, last_error = NULL, updated_at = NOW()
   RETURNING * INTO tok; RETURN tok; END;
   $$ LANGUAGE plpgsql`,

  // Enable RLS
  `ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY`,

  // RLS policy
  `CREATE POLICY "service_role_only_oauth_tokens" ON oauth_tokens FOR ALL TO service_role USING (true) WITH CHECK (true)`,

  // Log migration
  `INSERT INTO logs_v2 (event, message, metadata) VALUES ('schema_migration', 'OAuth tokens schema v2.6 applied', '{"version": "20260217000000", "features": ["oauth_tokens", "encrypted_storage", "token_lifecycle_rpcs"]}'::jsonb)`,
];

async function applyMigration() {
  console.log("Applying OAuth tokens migration...\n");
  console.log(`Supabase URL: ${SUPABASE_URL}\n`);

  // First check if table already exists
  const { data: existing, error: checkError } = await supabase
    .from('oauth_tokens')
    .select('id')
    .limit(1);

  if (!checkError) {
    console.log("✅ oauth_tokens table already exists");

    // Check for upsert_oauth_token function
    const { error: rpcError } = await supabase.rpc('upsert_oauth_token', {
      p_provider: 'test',
      p_email: 'test@test.com',
      p_access_token_encrypted: 'test'
    });

    if (!rpcError || !rpcError.message.includes('Could not find')) {
      console.log("✅ upsert_oauth_token RPC already exists");
      console.log("\nMigration already applied. Nothing to do.");
      return;
    }
  }

  console.log("Applying SQL statements...\n");

  // Try to apply via exec_sql if available
  let appliedAny = false;
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i];
    const preview = sql.substring(0, 50).replace(/\n/g, ' ');
    process.stdout.write(`[${i + 1}/${statements.length}] ${preview}... `);

    try {
      const { error } = await supabase.rpc('exec_sql', { query: sql });

      if (error) {
        if (error.message.includes('Could not find') || error.code === 'PGRST202') {
          console.log("⚠️  exec_sql not available");
          console.log("\n\n=== MANUAL APPLICATION REQUIRED ===");
          console.log("\nThe exec_sql RPC is not available in this Supabase project.");
          console.log("Please apply the migration manually:\n");
          console.log("1. Go to Supabase Dashboard > SQL Editor:");
          console.log(`   ${SUPABASE_URL.replace('/rest/v1', '')}/project/_/sql/new\n`);
          console.log("2. Copy the contents of: supabase/migrations/20260217000000_oauth_tokens_schema.sql");
          console.log("3. Paste and execute\n");

          // Output the SQL for convenience
          const migrationPath = join(import.meta.dir, '..', 'supabase', 'migrations', '20260217000000_oauth_tokens_schema.sql');
          const migrationSQL = readFileSync(migrationPath, 'utf-8');
          console.log("\n--- MIGRATION SQL ---\n");
          console.log(migrationSQL);
          console.log("\n--- END MIGRATION SQL ---\n");

          process.exit(1);
        }
        throw error;
      }
      console.log("✅");
      appliedAny = true;
    } catch (err) {
      console.log("❌");
      console.error(`  Error: ${err}`);
    }
  }

  if (appliedAny) {
    console.log("\n✅ Migration complete!");
  }
}

applyMigration();
