/**
 * Check Email Tables Status
 *
 * Verifies if email tables exist in Supabase.
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function checkTables() {
  console.log('Checking email tables in Supabase...\n');

  const tables = ['email_accounts', 'email_sync_state', 'email_messages'];
  const missing: string[] = [];

  for (const table of tables) {
    const { error, count } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.log(`✗ ${table}: NOT FOUND`);
      missing.push(table);
    } else {
      console.log(`✓ ${table}: exists (${count} rows)`);
    }
  }

  if (missing.length > 0) {
    console.log('\n===========================================');
    console.log('ACTION REQUIRED: Apply migration manually');
    console.log('===========================================');
    console.log('\n1. Go to Supabase Dashboard → SQL Editor');
    console.log('2. Create a new query');
    console.log('3. Paste the contents of:');
    console.log('   supabase/migrations/20260216160000_email_sync_schema.sql');
    console.log('4. Execute the migration');
    console.log('\nOr use the Supabase CLI:');
    console.log('   npx supabase db push');
  } else {
    console.log('\n✓ All email tables are ready!');
  }
}

checkTables().catch(console.error);
