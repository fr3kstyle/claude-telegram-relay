import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://nlkgqooefwbupwubloae.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verify() {
  console.log('=== VERIFYING EMAIL SYNC MIGRATION ===\n');

  // Check email tables
  const tables = ['email_accounts', 'email_sync_state', 'email_messages'];
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('id').limit(1);
    console.log(`${table}: ${error ? '❌ MISSING - ' + error.message : '✅ EXISTS'}`);
  }

  // Check RPC exists
  const { error: rpcError } = await supabase.rpc('search_emails_text', {
    p_query: 'test',
    p_match_count: 1
  });
  console.log(`search_emails_text RPC: ${rpcError && rpcError.message.includes('not found') ? '❌ MISSING' : '✅ EXISTS'}`);
}

verify();
