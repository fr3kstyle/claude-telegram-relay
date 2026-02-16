/**
 * Test Gmail API Access
 *
 * Verifies OAuth tokens work and Gmail API is accessible.
 */

import { getValidAccessToken } from '../src/google-oauth.ts';

async function test() {
  const accounts = ['Fr3kchy@gmail.com', 'fr3k@mcpintelligence.com.au'];

  for (const email of accounts) {
    console.log(`\nTesting ${email}...`);

    try {
      const token = await getValidAccessToken(email);
      console.log("  ✓ Got valid access token");

      // Test Gmail API
      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.ok) {
        const profile = await response.json();
        console.log("  ✓ Gmail API accessible");
        console.log(`    Email: ${profile.emailAddress}`);
        console.log(`    Messages: ${profile.messagesTotal}`);
        console.log(`    Threads: ${profile.threadsTotal}`);
      } else {
        const error = await response.text();
        console.log(`  ✗ Gmail API error: ${response.status}`);
        console.log(`    ${error}`);
      }
    } catch (err) {
      console.log(`  ✗ Error: ${(err as Error).message}`);
    }
  }
}

test().catch(console.error);
