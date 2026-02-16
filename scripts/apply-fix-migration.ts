#!/usr/bin/env bun
/**
 * Check and report on missing schema elements
 * Provides instructions for manual migration via Supabase Dashboard
 *
 * Run: bun run scripts/apply-fix-migration.ts
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function checkAndReport() {
  console.log('=== SCHEMA STATUS CHECK ===\n');

  // Check tables
  console.log('1. TABLES:');
  const tables = ['agent_loop_state', 'email_accounts', 'email_messages', 'email_sync_state'];

  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1);
    console.log(`   ${table}: ${error ? '❌ MISSING' : '✅'}`);
  }

  // Check memory columns by trying to insert
  console.log('\n2. MEMORY COLUMNS:');
  const testContent = `schema-check-${Date.now()}`;
  const { error: insertErr } = await supabase.from('memory').insert({
    type: 'fact',
    content: testContent,
    retry_count: 0,
    status: 'active',
    metadata: { test: true }
  }).select();

  if (insertErr) {
    if (insertErr.message.includes('retry_count')) {
      console.log('   retry_count: ❌ MISSING');
    } else if (insertErr.message.includes('metadata')) {
      console.log('   metadata: ❌ MISSING');
    } else if (insertErr.message.includes('status')) {
      console.log('   status: ❌ MISSING');
    } else {
      console.log(`   ⚠️ ${insertErr.message.substring(0, 60)}`);
    }
  } else {
    console.log('   retry_count: ✅');
    console.log('   status: ✅');
    console.log('   metadata: ✅');
    // Cleanup
    await supabase.from('memory').delete().eq('content', testContent);
  }

  // Check RPCs
  console.log('\n3. RPCs:');
  const rpcs = [
    { name: 'get_pending_actions', params: { limit_count: 5 } },
    { name: 'get_strategies', params: {} },
    { name: 'get_agent_state', params: {} },
    { name: 'search_emails_text', params: { p_query: 'test', p_match_count: 1 } },
  ];

  for (const rpc of rpcs) {
    // @ts-ignore - dynamic RPC calls
    const { error } = await supabase.rpc(rpc.name, rpc.params);
    const missing = error && error.message.includes('not found');
    console.log(`   ${rpc.name}: ${missing ? '❌ MISSING' : '✅'}`);
  }

  // Data status
  console.log('\n4. DATA STATUS:');
  const { count: goalCount } = await supabase.from('memory').select('*', { count: 'exact', head: true }).eq('type', 'goal');
  const { count: actionCount } = await supabase.from('memory').select('*', { count: 'exact', head: true }).eq('type', 'action');
  const { count: totalCount } = await supabase.from('memory').select('*', { count: 'exact', head: true });

  console.log(`   Total memory records: ${totalCount}`);
  console.log(`   Goals: ${goalCount}`);
  console.log(`   Actions: ${actionCount}`);

  // Recommendations
  console.log('\n=== RECOMMENDATIONS ===\n');

  const missing: string[] = [];

  // Check agent_loop_state
  const { error: alsErr } = await supabase.from('agent_loop_state').select('id').limit(1);
  if (alsErr) missing.push('agent_loop_state table');

  // Check memory columns
  if (insertErr) missing.push('memory columns (retry_count, status, metadata)');

  if (missing.length > 0) {
    console.log('MISSING ELEMENTS:');
    missing.forEach(m => console.log(`  - ${m}`));
    console.log('\n📋 TO FIX: Copy and paste this SQL into Supabase Dashboard SQL Editor:');
    console.log('   https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new');
    console.log('\n   File: supabase/migrations/20260216180000_fix_missing_schema.sql\n');
  } else {
    console.log('✅ All schema elements present!');
  }

  // Goal cleanup recommendation
  if (goalCount && goalCount > 50) {
    console.log(`\n⚠️  GOAL HYGIENE: ${goalCount} goals is excessive. Consider cleanup.`);
    console.log('   Run: bun run scripts/cleanup-goals.ts');
  }
}

checkAndReport();
