/**
 * Seed Email Accounts
 *
 * Seeds the email_accounts table with authorized Google OAuth accounts.
 * Uses the get_or_create_email_account RPC for idempotency.
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Authorized Google accounts (matching google-oauth.ts)
const ACCOUNTS = [
  { email: 'Fr3kchy@gmail.com', display_name: 'Personal Gmail' },
  { email: 'fr3k@mcpintelligence.com.au', display_name: 'MCP Intelligence' },
];

async function seedEmailAccounts() {
  console.log('Seeding email accounts...\n');

  for (const account of ACCOUNTS) {
    const { data, error } = await supabase.rpc('get_or_create_email_account', {
      p_email: account.email,
      p_display_name: account.display_name,
      p_provider: 'gmail',
    });

    if (error) {
      console.log(`✗ ${account.email}: ${error.message}`);
    } else {
      console.log(`✓ ${account.email} (${account.display_name})`);
      console.log(`  ID: ${data.id}`);
      console.log(`  Active: ${data.is_active}, Sync: ${data.sync_enabled}`);
    }
  }

  // Verify
  const { data: accounts, error: listError } = await supabase
    .from('email_accounts')
    .select('*');

  if (listError) {
    console.error('\nFailed to verify:', listError.message);
    return;
  }

  console.log(`\nTotal email accounts: ${accounts?.length || 0}`);
}

seedEmailAccounts().catch(console.error);
