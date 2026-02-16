/**
 * Test Email Provider Integration
 */

import { 
  getEmailProviderFactory, 
  getAuthorizedGmailProviders, 
  getAuthorizedEmailAccounts 
} from '../src/email/index.ts';

async function test() {
  console.log('=== Email Provider Integration Test ===\n');
  
  // Test 1: Factory initialization
  console.log('1. Testing EmailProviderFactory...');
  const factory = getEmailProviderFactory();
  const types = factory.getRegisteredTypes();
  console.log(`   Registered providers: ${types.join(', ')}`);
  
  // Test 2: Account discovery
  console.log('\n2. Testing account discovery...');
  const accounts = await getAuthorizedEmailAccounts();
  console.log(`   Discovered accounts: ${accounts.length > 0 ? accounts.join(', ') : 'None'}`);
  
  // Test 3: Gmail provider creation
  if (accounts.length > 0) {
    console.log('\n3. Testing Gmail provider for first account...');
    try {
      const provider = factory.createProvider('gmail', accounts[0]);
      const info = await provider.getProviderInfo();
      console.log(`   Provider info: type=${info.type}, email=${info.emailAddress}`);
      
      // Test 4: Authentication check
      console.log('\n4. Testing authentication...');
      const isAuth = await provider.isAuthenticated();
      console.log(`   Authenticated: ${isAuth}`);
      
      if (isAuth) {
        // Test 5: List messages
        console.log('\n5. Testing listMessages (max 3)...');
        const result = await provider.listMessages({ maxResults: 3 });
        console.log(`   Retrieved ${result.messages.length} messages`);
        for (const msg of result.messages) {
          console.log(`   - [${msg.id.substring(0, 8)}] ${msg.subject?.substring(0, 40) || '(no subject)'}`);
        }
      }
    } catch (err) {
      console.log(`   Error: ${err}`);
    }
  }
  
  console.log('\n=== Test Complete ===');
}

test().catch(console.error);
