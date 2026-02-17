#!/usr/bin/env bun
/**
 * Apply pending Supabase migrations via psql
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun run setup/apply-migrations.ts
 *
 * Get DATABASE_URL from Supabase Dashboard:
 *   Settings > Database > Connection string > URI
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { $ } from 'bun';

const MIGRATIONS_DIR = join(import.meta.dir, '../supabase/migrations');

interface MigrationResult {
  file: string;
  success: boolean;
  error?: string;
}

async function applyMigration(filePath: string): Promise<MigrationResult> {
  const fileName = basename(filePath);

  if (!process.env.DATABASE_URL) {
    return {
      file: fileName,
      success: false,
      error: 'DATABASE_URL not set. Get it from Supabase Dashboard > Settings > Database > Connection string > URI'
    };
  }

  try {
    const sql = readFileSync(filePath, 'utf-8');

    // Use psql to apply the migration
    const result = await $`psql "${process.env.DATABASE_URL}" -c ${sql}`.quiet();

    if (result.exitCode !== 0) {
      return {
        file: fileName,
        success: false,
        error: result.stderr.toString() || 'Unknown psql error'
      };
    }

    return { file: fileName, success: true };
  } catch (error) {
    return {
      file: fileName,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main() {
  console.log('=== Supabase Migration Applier ===\n');

  if (!process.env.DATABASE_URL) {
    console.log('ERROR: DATABASE_URL environment variable not set.\n');
    console.log('To get your DATABASE_URL:');
    console.log('1. Go to Supabase Dashboard: https://supabase.com/dashboard');
    console.log('2. Select your project');
    console.log('3. Go to Settings > Database');
    console.log('4. Copy the "Connection string" (URI format)');
    console.log('5. Run: DATABASE_URL="your-connection-string" bun run setup/apply-migrations.ts\n');
    console.log('Alternative: Apply migrations manually in the SQL Editor:');
    console.log('https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new\n');
    process.exit(1);
  }

  // Get all migration files
  if (!existsSync(MIGRATIONS_DIR)) {
    console.log('ERROR: Migrations directory not found:', MIGRATIONS_DIR);
    process.exit(1);
  }

  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${migrationFiles.length} migration files.\n`);

  // Pending migrations from HEARTBEAT.md
  // Note: 20260216120000_fix_match_memory.sql was deployed 2026-02-17
  const pendingMigrations = [
    '20260216140000_goal_hygiene_rpc.sql',
    '20260217020000_email_stats_rpc.sql'
  ];

  console.log('Applying pending migrations:\n');

  const results: MigrationResult[] = [];

  for (const migration of pendingMigrations) {
    const filePath = join(MIGRATIONS_DIR, migration);
    if (!existsSync(filePath)) {
      console.log(`  SKIP: ${migration} (file not found)`);
      continue;
    }

    console.log(`  Applying: ${migration}...`);
    const result = await applyMigration(filePath);
    results.push(result);

    if (result.success) {
      console.log(`  SUCCESS: ${migration}\n`);
    } else {
      console.log(`  FAILED: ${migration}`);
      console.log(`  Error: ${result.error}\n`);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`Applied: ${succeeded}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed migrations:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.file}: ${r.error}`);
    });
    process.exit(1);
  }
}

main();
