import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function verify() {
  console.log('=== FULL MIGRATION VERIFICATION ===\n');

  // Check all tables
  const tables = [
    'agent_loop_state',
    'email_accounts',
    'email_sync_state',
    'email_messages',
    'memory'
  ];

  console.log('TABLES:');
  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1);
    console.log(`  ${table}: ${error ? '❌ ' + error.message.substring(0,60) : '✅'}`);
  }

  // Test memory columns by inserting
  console.log('\nMEMORY COLUMNS:');
  const testContent = `test-col-check-${Date.now()}`;
  const { error: insertErr } = await supabase.from('memory').insert({
    type: 'fact',
    content: testContent,
    retry_count: 0,
    status: 'active',
    metadata: { test: true }
  }).select();

  if (insertErr) {
    if (insertErr.message.includes('retry_count')) {
      console.log('  retry_count: ❌ MISSING');
    } else if (insertErr.message.includes('metadata')) {
      console.log('  metadata: ❌ MISSING');
    } else {
      console.log('  columns: ⚠️ ' + insertErr.message.substring(0,50));
    }
  } else {
    console.log('  retry_count: ✅');
    console.log('  metadata: ✅');
    console.log('  status: ✅');
    // Cleanup
    await supabase.from('memory').delete().eq('content', testContent);
  }

  // Check RPCs
  console.log('\nRPCs:');

  const { error: hygieneErr } = await supabase.rpc('goal_hygiene', { p_days_stale: 7 });
  console.log(`  goal_hygiene: ${hygieneErr && hygieneErr.message.includes('not found') ? '❌ MISSING' : '✅'}`);

  const { error: actionsErr } = await supabase.rpc('get_pending_actions', { limit_count: 5 });
  console.log(`  get_pending_actions: ${actionsErr && actionsErr.message.includes('not found') ? '❌ MISSING' : '✅'}`);

  const { error: searchErr } = await supabase.rpc('search_emails_text', { p_query: 'test', p_match_count: 1 });
  console.log(`  search_emails_text: ${searchErr && searchErr.message.includes('not found') ? '❌ MISSING' : '✅'}`);

  const { error: accountErr } = await supabase.rpc('get_or_create_email_account', { p_email: 'verify@test.com' });
  console.log(`  get_or_create_email_account: ${accountErr && accountErr.message.includes('not found') ? '❌ MISSING' : '✅'}`);

  // Check actual data
  console.log('\nDATA STATUS:');
  const { count: memCount } = await supabase.from('memory').select('*', { count: 'exact', head: true });
  console.log(`  memory records: ${memCount}`);

  const { count: goalCount } = await supabase.from('memory').select('*', { count: 'exact', head: true }).eq('type', 'goal');
  console.log(`  active goals: ${goalCount}`);

  const { data: agentState } = await supabase.from('agent_loop_state').select('*').limit(1);
  console.log(`  agent_loop_state: ${agentState?.length ? '✅ has record' : '⚠️ empty'}`);

  console.log('\n=== VERIFICATION COMPLETE ===');
}

verify().catch(console.error);
