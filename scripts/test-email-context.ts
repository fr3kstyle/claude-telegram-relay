/**
 * Test Email Context Integration
 */

import { fetchEmailContext, formatEmailContextForHeartbeat, hasUrgentEmails } from '../src/email/email-context.ts';

async function testEmailContext() {
  console.log('Testing email context integration...\n');

  // Test 1: Fetch email context
  console.log('1. Fetching email context...');
  const context = await fetchEmailContext({
    maxEmails: 5,
    includeRead: false,
    maxAgeHours: 24,
  });

  console.log(`   Found ${context.length} account(s)`);

  for (const account of context) {
    console.log(`   - ${account.account}: ${account.unreadCount} unread`);
    console.log(`     Recent: ${account.recentEmails.length}`);
    console.log(`     Important: ${account.importantEmails.length}`);
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
  console.log(`   Urgent emails: ${urgent ? 'YES' : 'no'}`);

  console.log('\nTest complete!');
}

testEmailContext().catch(console.error);
