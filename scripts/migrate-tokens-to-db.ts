/**
 * Token Migration Script
 *
 * Migrates OAuth tokens from file-based storage to encrypted database storage.
 * Run once to move existing tokens to the oauth_tokens table.
 *
 * Usage: bun run scripts/migrate-tokens-to-db.ts
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { getTokenManager } from '../src/auth/token-manager.ts';

const RELAY_DIR = join(process.env.HOME || '~', '.claude-relay');
const GOOGLE_TOKENS_DIR = join(RELAY_DIR, 'google-tokens');

interface FileTokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  email: string;
}

/**
 * Convert filename to email address
 * Fr3kchy_gmail_com.json -> Fr3kchy@gmail.com
 */
function filenameToEmail(filename: string): string {
  const safeEmail = filename.replace('.json', '');
  // Last two underscores become @ and .
  return safeEmail
    .replace(/_([^_]+)_([^_]+)$/, '@$1.$2')
    .replace(/_/g, '');
}

async function migrate() {
  console.log('=== OAuth Token Migration ===\n');

  if (!existsSync(GOOGLE_TOKENS_DIR)) {
    console.log('No Google tokens directory found. Nothing to migrate.');
    return;
  }

  const files = await readdir(GOOGLE_TOKENS_DIR);
  const tokenFiles = files.filter(f => f.endsWith('.json'));

  if (tokenFiles.length === 0) {
    console.log('No token files found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${tokenFiles.length} token file(s) to migrate.\n`);

  const tokenManager = getTokenManager();
  let successCount = 0;
  let errorCount = 0;

  for (const file of tokenFiles) {
    const email = filenameToEmail(file);
    console.log(`Migrating: ${email}`);

    try {
      const content = await readFile(join(GOOGLE_TOKENS_DIR, file), 'utf-8');
      const tokenData: FileTokenData = JSON.parse(content);

      // Store in database
      await tokenManager.storeToken('google', email, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(tokenData.expiry_date),
        scopes: tokenData.scope.split(' '),
        metadata: {
          tokenType: tokenData.token_type,
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

  console.log('\n=== Migration Complete ===');
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${errorCount}`);
  console.log('\nOriginal files have been preserved.');
  console.log('After verifying the migration, you can remove:');
  console.log(`  ${GOOGLE_TOKENS_DIR}/`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
