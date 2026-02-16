/**
 * Check Email Tables Status
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function checkTables() {
  console.log('Checking email tables in Supabase...\n');

  const tables = ['email_accounts', 'email_sync_state', 'email_messages'];

  for (const table of tables) {
    const { error, count } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.log(`✗ ${table}: ${error.message}`);
    } else {
      console.log(`✓ ${table}: exists (${count} rows)`);
    }
  }
}

checkTables().catch(console.error);
