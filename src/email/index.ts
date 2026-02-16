/**
 * Email Module
 *
 * Provider-agnostic email operations for the autonomous agent.
 */

export * from './types.ts';
export { GmailProvider, createGmailProvider } from './gmail-provider.ts';
export {
  fetchEmailContext,
  formatEmailContextForHeartbeat,
  hasUrgentEmails,
} from './email-context.ts';
export type { EmailContextOptions, EmailContextResult, EmailSummary } from './email-context.ts';

import { GmailProvider, createGmailProvider } from './gmail-provider.ts';
import { discoverAuthorizedAccounts } from '../google-oauth.ts';
import type { EmailProvider, EmailProviderType } from './types.ts';

/**
 * Create an email provider based on type
 */
export function createEmailProvider(
  type: EmailProviderType,
  emailAddress: string
): EmailProvider {
  switch (type) {
    case 'gmail':
      return createGmailProvider(emailAddress);
    case 'outlook':
      throw new Error('Outlook provider not yet implemented');
    case 'imap':
      throw new Error('IMAP provider not yet implemented');
    case 'smtp':
      throw new Error('SMTP provider not yet implemented');
    default:
      throw new Error(`Unknown email provider type: ${type}`);
  }
}

/**
 * Get all authorized Gmail providers by discovering accounts from tokens directory
 */
export async function getAuthorizedGmailProviders(): Promise<GmailProvider[]> {
  // Discover accounts dynamically from token files
  const accounts = await discoverAuthorizedAccounts();
  const providers: GmailProvider[] = [];

  for (const email of accounts) {
    const provider = createGmailProvider(email);
    try {
      if (await provider.isAuthenticated()) {
        providers.push(provider);
      }
    } catch {
      // Skip accounts that aren't authorized or have expired tokens
    }
  }

  return providers;
}

/**
 * Get list of discovered email accounts (for display/debugging)
 */
export async function getDiscoveredAccounts(): Promise<string[]> {
  return discoverAuthorizedAccounts();
}
