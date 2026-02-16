#!/usr/bin/env bun
/**
 * Comprehensive integration test for all email and Google API services
 * Combines tests from: test-google-apis.ts, test-email-provider.ts, test-email-context.ts
 *
 * Usage:
 *   bun run scripts/test-integration.ts          # Run all tests
 *   bun run scripts/test-integration.ts google   # Test Google APIs only
 *   bun run scripts/test-integration.ts email    # Test email provider only
 *   bun run scripts/test-integration.ts context  # Test email context only
 */

import {
  listEmails,
  listEvents,
  listFiles,
  getProfile,
  getAuthorizedAccounts
} from '../src/google-apis.ts';
import {
  getEmailProviderFactory,
  getAuthorizedEmailAccounts
} from '../src/email/index.ts';
import {
  fetchEmailContext,
  formatEmailContextForHeartbeat,
  hasUrgentEmails
} from '../src/email/email-context.ts';

async function testGoogleApis() {
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

  console.log('\n=== GOOGLE API TEST COMPLETE ===');
}

async function testEmailProvider() {
  console.log('=== EMAIL PROVIDER TEST ===\n');

  // Test 1: Factory initialization
  console.log('1. Testing EmailProviderFactory...');
  const factory = getEmailProviderFactory();
  const types = factory.getRegisteredTypes();
  console.log('   Registered providers: ' + types.join(', '));

  // Test 2: Account discovery
  console.log('\n2. Testing account discovery...');
  const accounts = await getAuthorizedEmailAccounts();
  console.log('   Discovered accounts: ' + (accounts.length > 0 ? accounts.join(', ') : 'None'));

  // Test 3: Gmail provider creation
  if (accounts.length > 0) {
    console.log('\n3. Testing Gmail provider for first account...');
    try {
      const provider = factory.createProvider('gmail', accounts[0]);
      const info = await provider.getProviderInfo();
      console.log('   Provider info: type=' + info.type + ', email=' + info.emailAddress);

      // Test 4: Authentication check
      console.log('\n4. Testing authentication...');
      const isAuth = await provider.isAuthenticated();
      console.log('   Authenticated: ' + isAuth);

      if (isAuth) {
        // Test 5: List messages
        console.log('\n5. Testing listMessages (max 3)...');
        const result = await provider.listMessages({ maxResults: 3 });
        console.log('   Retrieved ' + result.messages.length + ' messages');
        for (const msg of result.messages) {
          console.log('   - [' + msg.id.substring(0, 8) + '] ' + (msg.subject?.substring(0, 40) || '(no subject)'));
        }
      }
    } catch (err) {
      console.log('   Error: ' + err);
    }
  }

  console.log('\n=== EMAIL PROVIDER TEST COMPLETE ===');
}

async function testEmailContext() {
  console.log('=== EMAIL CONTEXT TEST ===\n');

  // Test 1: Fetch email context
  console.log('1. Fetching email context...');
  const context = await fetchEmailContext({
    maxEmails: 5,
    includeRead: false,
    maxAgeHours: 24,
  });

  console.log('   Found ' + context.length + ' account(s)');

  for (const account of context) {
    console.log('   - ' + account.account + ': ' + account.unreadCount + ' unread');
    console.log('     Recent: ' + account.recentEmails.length);
    console.log('     Important: ' + account.importantEmails.length);
  }

  // Test 2: Format for heartbeat
  console.log('\n2. Formatting for heartbeat:');
  const formatted = formatEmailContextForHeartbeat(context);
  console.log('---');
  console.log(formatted);
  console.log('---');

  // Test 3: Check urgent emails
  console.log('\n3. Checking for urgent emails...');
  const urgent = await hasUrgentEmails();
  console.log('   Urgent emails: ' + (urgent ? 'YES' : 'no'));

  console.log('\n=== EMAIL CONTEXT TEST COMPLETE ===');
}

async function main() {
  const arg = process.argv[2];

  console.log('╔═══════════════════════════════════════════╗');
  console.log('║    INTEGRATION TEST SUITE                 ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  if (arg === 'google') {
    await testGoogleApis();
  } else if (arg === 'email') {
    await testEmailProvider();
  } else if (arg === 'context') {
    await testEmailContext();
  } else {
    // Run all tests
    await testGoogleApis();
    console.log('\n');
    await testEmailProvider();
    console.log('\n');
    await testEmailContext();
  }

  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║    ALL TESTS COMPLETE                     ║');
  console.log('╚═══════════════════════════════════════════╝');
}

main().catch((e) => console.error('Error:', e));
