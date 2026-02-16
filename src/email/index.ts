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
export {
  validateEmail,
  detectProviderFromEmail,
  isValidProviderType,
  getProviderDisplayName,
  sanitizeDisplayName,
  validateEmailWithProvider,
  parseOAuthError,
} from './validation.ts';
export type { EmailValidationResult, OAuthErrorCategory, ParsedOAuthError } from './validation.ts';

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

// ============================================================
// RELAY ADAPTER FUNCTIONS
// ============================================================
// These functions provide a backward-compatible interface for relay.ts
// to use the new provider abstraction without major code changes.

import type { EmailMessage, ListMessagesOptions } from './types.ts';

/**
 * Relay message format - compatible with google-apis.ts GmailMessage
 */
export interface RelayEmailMessage {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  snippet?: string;
  body?: string;
  unread?: boolean;
  starred?: boolean;
  labels?: string[];
}

/**
 * Get authorized email accounts (provider-agnostic)
 *
 * Discovers accounts from both database and token files.
 * Returns email addresses of all authorized accounts.
 */
export async function getAuthorizedEmailAccounts(): Promise<string[]> {
  const factory = getEmailProviderFactory();

  // First try database discovery
  const accounts = await factory.discoverAccounts();

  // Filter to only active accounts
  const activeAccounts = accounts.filter(a => a.isActive);

  // Fall back to token file discovery if no database accounts
  if (activeAccounts.length === 0) {
    return discoverAuthorizedAccounts();
  }

  return activeAccounts.map(a => a.emailAddress);
}

/**
 * List emails using provider abstraction
 *
 * Adapter function that works with any email provider.
 */
export async function listEmailsForRelay(
  email: string,
  options: { maxResults?: number; labelIds?: string[]; query?: string } = {}
): Promise<RelayEmailMessage[]> {
  const factory = getEmailProviderFactory();
  const provider = await factory.getProvider(email);

  if (!provider) {
    throw new Error(`No provider available for ${email}`);
  }

  // Build provider options
  const providerOptions: ListMessagesOptions = {
    maxResults: options.maxResults || 10,
    labelIds: options.labelIds,
    query: options.query,
  };

  // Use search if query provided, otherwise list
  const result = options.query
    ? await provider.searchMessages({ query: options.query, maxResults: options.maxResults || 10 })
    : await provider.listMessages(providerOptions);

  // Convert to relay format
  return result.messages.map(emailMessageToRelayFormat);
}

/**
 * Get a single email using provider abstraction
 */
export async function getEmailForRelay(
  email: string,
  messageId: string
): Promise<RelayEmailMessage | null> {
  const factory = getEmailProviderFactory();
  const provider = await factory.getProvider(email);

  if (!provider) {
    throw new Error(`No provider available for ${email}`);
  }

  try {
    const msg = await provider.getMessage(messageId);
    return emailMessageToRelayFormat(msg);
  } catch (error) {
    console.error(`[Email] Failed to get message ${messageId}:`, error);
    return null;
  }
}

/**
 * Convert EmailMessage to RelayEmailMessage format
 */
function emailMessageToRelayFormat(msg: EmailMessage): RelayEmailMessage {
  // Format from address as "Name <email@domain.com>"
  const fromFormatted = msg.from?.name
    ? `${msg.from.name} <${msg.from.address}>`
    : msg.from?.address || 'Unknown';

  // Format to addresses
  const toFormatted = msg.to?.map(t => t.name ? `${t.name} <${t.address}>` : t.address).join(', ');

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: msg.subject || undefined,
    from: fromFormatted,
    to: toFormatted,
    date: msg.date?.toISOString(),
    snippet: msg.snippet?.substring(0, 500),
    body: msg.bodyText,
    unread: msg.flags?.isRead === false,
    starred: msg.flags?.isStarred || false,
    labels: msg.labels,
  };
}

/**
 * Send an email using provider abstraction
 *
 * Adapter function that works with any email provider (Gmail, Outlook, etc.)
 */
export async function sendEmailForRelay(
  fromEmail: string,
  options: {
    to: string;
    subject: string;
    body: string;
    html?: boolean;
  }
): Promise<{ id: string; threadId?: string }> {
  const factory = getEmailProviderFactory();
  const provider = await factory.getProvider(fromEmail);

  if (!provider) {
    throw new Error(`No provider available for ${fromEmail}`);
  }

  // Parse the 'to' address into EmailAddress format
  const toMatch = options.to.match(/(?:"?([^"]*)"?\s)?<?([^\s>]+@[^\s>]+)>?/);
  const toAddress = toMatch
    ? { address: toMatch[2], name: toMatch[1]?.trim() }
    : { address: options.to, name: undefined };

  // Build send options
  const sendOptions = {
    to: [toAddress],
    subject: options.subject,
    bodyText: options.html ? undefined : options.body,
    bodyHtml: options.html ? options.body : undefined,
  };

  const result = await provider.sendMessage(sendOptions);
  return { id: result.id, threadId: result.threadId };
}
