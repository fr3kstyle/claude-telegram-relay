#!/usr/bin/env bun
/**
 * Test Google API access for all services
 */

import { listEmails, listEvents, listFiles, getProfile, getAuthorizedAccounts } from '../src/google-apis.ts';

async function test() {
  console.log('=== GOOGLE API VERIFICATION ===\n');

  const accounts = await getAuthorizedAccounts();
  console.log('Authorized accounts:', accounts.join(', '));

  for (const email of accounts) {
    console.log('\n--- ' + email + ' ---');

    // Test profile
    try {
      const profile = await getProfile(email);
      console.log('Profile: ' + profile.name + ' (' + profile.email + ')');
    } catch (e: any) {
      console.log('Profile: FAILED - ' + e.message);
    }

    // Test Gmail
    try {
      const emails = await listEmails(email, { maxResults: 5 });
      console.log('Gmail: ' + emails.length + ' recent emails');
      if (emails.length > 0) {
        console.log('  Latest: ' + (emails[0].subject || '(no subject)').substring(0, 50));
      }
    } catch (e: any) {
      console.log('Gmail: FAILED - ' + e.message);
    }

    // Test Calendar
    try {
      const events = await listEvents(email, { maxResults: 5 });
      console.log('Calendar: ' + events.length + ' upcoming events');
      if (events.length > 0) {
        console.log('  Next: ' + (events[0].summary || '(no title)').substring(0, 50));
      }
    } catch (e: any) {
      console.log('Calendar: FAILED - ' + e.message);
    }

    // Test Drive
    try {
      const files = await listFiles(email, { maxResults: 5 });
      console.log('Drive: ' + files.length + ' recent files');
      if (files.length > 0) {
        console.log('  Latest: ' + files[0].name.substring(0, 50));
      }
    } catch (e: any) {
      console.log('Drive: FAILED - ' + e.message);
    }
  }

  console.log('\n=== VERIFICATION COMPLETE ===');
}

test().catch((e) => console.error('Error:', e));
