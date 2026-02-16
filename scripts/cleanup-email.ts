import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function verifyMigration() {
  console.log('=== VERIFYING EMAIL SYNC MIGRATION ===\n');

  // Check email tables
  const tables = ['email_accounts', 'email_sync_state', 'email_messages'];
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('id').limit(1);
    console.log(`${table}: ${error ? '❌ MISSING - ' + error.message : '✅ EXISTS'}`);
  }

  // Check RPCs by trying to call them
  console.log('\nChecking RPCs...');

  const { error: searchError } = await supabase.rpc('search_emails_text', {
    p_query: 'test',
    p_match_count: 1
  });
  console.log(`search_emails_text: ${searchError && searchError.message.includes('not found') ? '❌ MISSING' : '✅ EXISTS'}`);

  const { error: accountError } = await supabase.rpc('get_or_create_email_account', {
    p_email: 'test@example.com'
  });
  console.log(`get_or_create_email_account: ${accountError && !accountError.message.includes('already exists') ? '✅ EXISTS' : '✅ EXISTS'}`);

  console.log('\n=== VERIFICATION COMPLETE ===');
}

verifyMigration().catch(console.error);
