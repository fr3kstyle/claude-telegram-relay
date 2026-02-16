/**
 * Email Module
 *
 * Provider-agnostic email operations for the autonomous agent.
 */

export * from './types.ts';
export { GmailProvider, createGmailProvider } from './gmail-provider.ts';
export { OutlookProvider, createOutlookProvider } from './outlook-provider.ts';
export {
  EmailProviderFactory,
  getEmailProviderFactory,
  createEmailProvider as createProviderFromFactory,
  getAuthorizedProviders,
} from './provider-factory.ts';
export {
  fetchEmailContext,
  formatEmailContextForHeartbeat,
  hasUrgentEmails,
} from './email-context.ts';
export type { EmailContextOptions, EmailContextResult, EmailSummary } from './email-context.ts';

import { GmailProvider, createGmailProvider } from './gmail-provider.ts';
import { getEmailProviderFactory } from './provider-factory.ts';
import { discoverAuthorizedAccounts } from '../google-oauth.ts';
import type { EmailProvider, EmailProviderType } from './types.ts';

/**
 * Create an email provider based on type
 *
 * Uses the EmailProviderFactory singleton for provider creation.
 */
export function createEmailProvider(
  type: EmailProviderType,
  emailAddress: string
): EmailProvider {
  return getEmailProviderFactory().createProvider(type, emailAddress);
}

/**
 * Get all authorized Gmail providers by discovering accounts from tokens directory
 */
export async function getAuthorizedGmailProviders(): Promise<GmailProvider[]> {
  // Discover accounts dynamically from token files
  const accounts = await discoverAuthorizedAccounts();
  const factory = getEmailProviderFactory();
  const providers: GmailProvider[] = [];

  for (const email of accounts) {
    try {
      const provider = factory.createProvider('gmail', email) as GmailProvider;
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
