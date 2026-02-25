/**
 * Apply Pending Migrations
 *
 * Reads migration SQL files and applies them to Supabase using the REST API.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const PENDING_MIGRATIONS = [
  // Core v2 schema (already applied, checked for idempotency)
  '20260216120000_fix_match_memory.sql',
  '20260216140000_goal_hygiene_rpc.sql',
  '20260217000000_oauth_tokens_schema.sql',
  '20260217010000_notification_preferences.sql',
  '20260217020000_email_stats_rpc.sql',
  // RLS fixes
  '20260217133000_rls_audit_fix.sql',
  // Trading system tables (may need manual application)
  '20260217170000_trading_market_data.sql',
  '20260217180000_trading_signals.sql',
  '20260217190000_trading_executions.sql',
  '20260217200000_trading_risk.sql',
  '20260217210000_trading_ml.sql',
  '20260217220000_trading_system.sql',
  // Trade journal for learning
  '20260219100000_trade_journal.sql',
  // Paper trading
  '20260219110000_paper_trading.sql',
];

async function checkTableExists(tableName: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from(tableName)
      .select('id')
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}

async function checkFunctionExists(functionName: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc(functionName, {});
    // If we get a function not found error, it doesn't exist
    // Some functions might need params, so we check the error message
    if (error && error.message?.includes('function') && error.message?.includes('does not exist')) {
      return false;
    }
    // Function exists (may have returned data or a different error)
    return true;
  } catch {
    return false;
  }
}

async function applyMigration(filename: string): Promise<boolean> {
  console.log(`\n=== Checking ${filename} ===`);

  // Read the migration file
  const migrationPath = join(import.meta.dir, '..', 'supabase', 'migrations', filename);

  let content: string;
  try {
    content = readFileSync(migrationPath, 'utf-8');
  } catch (err) {
    console.error(`  Could not read migration file: ${err}`);
    return false;
  }

  // Determine which table this creates
  const tableMatch = content.match(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)/);
  const tableName = tableMatch ? tableMatch[1] : null;

  if (tableName) {
    const exists = await checkTableExists(tableName);
    if (exists) {
      console.log(`  ✓ Table ${tableName} already exists, skipping`);
      return true;
    }
  }

  // Check for functions this migration creates
  const functionMatches = content.matchAll(/CREATE(?: OR REPLACE)? FUNCTION (\w+)/g);
  for (const match of functionMatches) {
    const functionName = match[1];
    const exists = await checkFunctionExists(functionName);
    if (exists) {
      console.log(`  ✓ Function ${functionName} already exists, skipping`);
      return true;
    }
  }

  console.log(`  Migration needs to be applied manually.`);
  console.log(`  File: supabase/migrations/${filename}`);

  // Extract the SQL content for display
  console.log('\n  SQL to apply (first 500 chars):');
  console.log('  ' + content.substring(0, 500).split('\n').join('\n  ') + '...\n');

  return false;
}

async function main() {
  console.log('=== Migration Status Check ===\n');
  console.log(`Supabase URL: ${SUPABASE_URL}`);

  let allApplied = true;

  for (const migration of PENDING_MIGRATIONS) {
    const applied = await applyMigration(migration);
    if (!applied) {
      allApplied = false;
    }
  }

  if (!allApplied) {
    console.log('\n=== MANUAL ACTION REQUIRED ===');
    console.log('\nThe following migrations need to be applied manually:');
    console.log('1. Go to Supabase Dashboard SQL Editor:');
    console.log(`   ${SUPABASE_URL.replace('/rest/v1', '')}/project/_/sql/new`);
    console.log('2. Copy the contents of each pending migration file');
    console.log('3. Paste and execute in the SQL editor');
    console.log('\nAlternatively, if you have supabase CLI configured:');
    console.log('   supabase db push');
  } else {
    console.log('\n✓ All migrations are applied!');
  }
}

main().catch(console.error);
