import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkColumnExists(table: string, column: string): Promise<boolean> {
  const { error } = await supabase
    .from(table)
    .select(column)
    .limit(1);
  return !error || !error.message.includes('column');
}

async function main() {
  console.log("Checking current schema state...\n");

  // Check which columns exist
  const columns = ['parent_id', 'status', 'weight', 'retry_count', 'last_error', 'metadata'];
  const columnStatus: Record<string, boolean> = {};

  for (const col of columns) {
    columnStatus[col] = await checkColumnExists('global_memory', col);
    console.log(`  ${col}: ${columnStatus[col] ? '✓ exists' : '✗ missing'}`);
  }

  // Check if memory view exists
  const { error: viewError } = await supabase.from('memory').select('id').limit(1);
  console.log(`  memory view: ${!viewError ? '✓ exists' : '✗ missing'}`);

  // Check if agent_loop_state exists
  const { error: tableError } = await supabase.from('agent_loop_state').select('id').limit(1);
  console.log(`  agent_loop_state: ${!tableError ? '✓ exists' : '✗ missing'}`);

  // Summary
  const missingColumns = columns.filter(c => !columnStatus[c]);
  if (missingColumns.length === 0 && !viewError && !tableError) {
    console.log("\n✓ Schema is up to date. No migration needed.");
    return;
  }

  console.log(`\n⚠️  Migration required. Missing: ${missingColumns.join(', ')}`);
  console.log("\nTo apply migrations, run this SQL in Supabase Dashboard SQL Editor:");
  console.log("  File: supabase/migrations/20260216150000_unified_autonomous_schema.sql");
  console.log("\nOr apply individual column additions:");
  
  for (const col of missingColumns) {
    const typeMap: Record<string, string> = {
      'parent_id': 'UUID REFERENCES global_memory(id) ON DELETE CASCADE',
      'status': "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'blocked', 'completed', 'archived'))",
      'weight': 'FLOAT DEFAULT 1.0',
      'retry_count': 'INTEGER DEFAULT 0',
      'last_error': 'TEXT',
      'metadata': "JSONB DEFAULT '{}'"
    };
    console.log(`  ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS ${col} ${typeMap[col]};`);
  }
}

main().catch(console.error);
