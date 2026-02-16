/**
 * Token Migration Script
 *
 * Migrates OAuth tokens from file-based storage to encrypted database storage.
 * Run once to move existing tokens to the oauth_tokens table.
 * Supports both Google and Microsoft tokens.
 *
 * Usage: bun run scripts/migrate-tokens-to-db.ts
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { getTokenManager, type OAuthProvider } from '../src/auth/token-manager.ts';

const RELAY_DIR = join(process.env.HOME || '~', '.claude-relay');
const GOOGLE_TOKENS_DIR = join(RELAY_DIR, 'google-tokens');
const MICROSOFT_TOKENS_DIR = join(RELAY_DIR, 'microsoft-tokens');

interface FileTokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  email: string;
  account_type?: 'personal' | 'organizational';
}

/**
 * Convert filename to email address
 * Fr3kchy_gmail_com.json -> Fr3kchy@gmail.com
 * user_outlook_com.json -> user@outlook.com
 */
function filenameToEmail(filename: string): string {
  const safeEmail = filename.replace('.json', '');
  // Last two underscores become @ and .
  return safeEmail
    .replace(/_([^_]+)_([^_]+)$/, '@$1.$2')
    .replace(/_/g, '');
}

async function migrateProviderTokens(
  provider: OAuthProvider,
  tokensDir: string
): Promise<{ success: number; errors: number }> {
  console.log(`\n--- ${provider.toUpperCase()} Tokens ---\n`);

  if (!existsSync(tokensDir)) {
    console.log(`No ${provider} tokens directory found. Skipping.`);
    return { success: 0, errors: 0 };
  }

  const files = await readdir(tokensDir);
  const tokenFiles = files.filter(f => f.endsWith('.json'));

  if (tokenFiles.length === 0) {
    console.log(`No ${provider} token files found. Skipping.`);
    return { success: 0, errors: 0 };
  }

  console.log(`Found ${tokenFiles.length} ${provider} token file(s) to migrate.\n`);

  const tokenManager = getTokenManager();
  let successCount = 0;
  let errorCount = 0;

  for (const file of tokenFiles) {
    const email = filenameToEmail(file);
    console.log(`Migrating: ${email}`);

    try {
      const content = await readFile(join(tokensDir, file), 'utf-8');
      const tokenData: FileTokenData = JSON.parse(content);

      // Store in database
      await tokenManager.storeToken(provider, email, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(tokenData.expiry_date),
        scopes: tokenData.scope.split(' '),
        metadata: {
          tokenType: tokenData.token_type,
          accountType: tokenData.account_type,
          migratedFrom: file,
          migratedAt: new Date().toISOString(),
        },
      });

      console.log(`  ✓ Migrated successfully`);
      successCount++;
    } catch (err) {
      console.error(`  ✗ Failed: ${err instanceof Error ? err.message : err}`);
      errorCount++;
    }
  }

  return { success: successCount, errors: errorCount };
}

async function migrate() {
  console.log('=== OAuth Token Migration ===\n');

  const tokenManager = getTokenManager();

  // Migrate Google tokens
  const googleResults = await migrateProviderTokens('google', GOOGLE_TOKENS_DIR);

  // Migrate Microsoft tokens
  const microsoftResults = await migrateProviderTokens('microsoft', MICROSOFT_TOKENS_DIR);

  // Summary
  const totalSuccess = googleResults.success + microsoftResults.success;
  const totalErrors = googleResults.errors + microsoftResults.errors;

  console.log('\n=== Migration Complete ===');
  console.log(`Total Success: ${totalSuccess}`);
  console.log(`Total Failed: ${totalErrors}`);
  console.log(`  Google: ${googleResults.success} success, ${googleResults.errors} failed`);
  console.log(`  Microsoft: ${microsoftResults.success} success, ${microsoftResults.errors} failed`);
  console.log('\nOriginal files have been preserved.');
  console.log('After verifying the migration, you can remove:');
  if (googleResults.success > 0) {
    console.log(`  ${GOOGLE_TOKENS_DIR}/`);
  }
  if (microsoftResults.success > 0) {
    console.log(`  ${MICROSOFT_TOKENS_DIR}/`);
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
