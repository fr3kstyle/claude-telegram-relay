/**
 * Email Context Fetcher
 *
 * Provides email context for heartbeat and other agent operations.
 * Fetches recent emails from authorized email accounts (Gmail, Outlook, etc.)
 * using the provider abstraction and formats them for inclusion in prompts.
 */

import { getEmailProviderFactory } from './provider-factory.ts';
import type { EmailProvider, EmailMessage } from './types.ts';

export interface EmailContextOptions {
  maxEmails?: number;        // Max emails per account (default: 5)
  includeRead?: boolean;     // Include read emails (default: false)
  maxAgeHours?: number;      // Only emails from last N hours (default: 24)
  accounts?: string[];       // Specific accounts to check (default: all authorized)
}

export interface EmailContextResult {
  account: string;
  providerType: string;      // 'gmail', 'outlook', etc.
  unreadCount: number;
  recentEmails: EmailSummary[];
  importantEmails: EmailSummary[];
}

export interface EmailSummary {
  from: string;
  subject: string;
  date: Date;
  snippet: string;
  isRead: boolean;
  isStarred: boolean;
  labels?: string[];
}

/**
 * Get all authorized email providers using the factory
 *
 * Uses provider-agnostic discovery to find all authorized accounts
 * from both database and token files.
 */
async function getAuthorizedProviders(accounts?: string[]): Promise<Array<{ email: string; provider: EmailProvider; providerType: string }>> {
  const factory = getEmailProviderFactory();

  // If specific accounts requested, use those
  if (accounts && accounts.length > 0) {
    const providers: Array<{ email: string; provider: EmailProvider; providerType: string }> = [];
    const allAccounts = await factory.discoverAccounts();
    const accountMap = new Map(allAccounts.map(a => [a.emailAddress, a]));

    for (const email of accounts) {
      const provider = await factory.getProvider(email);
      if (provider) {
        const accountInfo = accountMap.get(email);
        providers.push({
          email,
          provider,
          providerType: accountInfo?.providerType || 'gmail' // Default to gmail for fallback
        });
      }
    }
    return providers;
  }

  // Otherwise discover all authorized accounts
  const discoveredAccounts = await factory.discoverAccounts();
  const providers: Array<{ email: string; provider: EmailProvider; providerType: string }> = [];

  for (const account of discoveredAccounts) {
    if (!account.isActive) continue;
    try {
      const provider = await factory.getProvider(account.emailAddress);
      if (provider && await provider.isAuthenticated()) {
        providers.push({
          email: account.emailAddress,
          provider,
          providerType: account.providerType
        });
      }
    } catch (error) {
      console.error(`[EmailContext] Failed to authenticate ${account.emailAddress}:`, error);
    }
  }

  return providers;
}

/**
 * Check if email is within the age limit
 */
function isWithinAgeLimit(date: Date, maxAgeHours: number): boolean {
  const cutoff = Date.now() - (maxAgeHours * 60 * 60 * 1000);
  return date.getTime() > cutoff;
}

/**
 * Summarize an email message
 */
function summarizeEmail(msg: EmailMessage): EmailSummary {
  return {
    from: msg.from.name ? `${msg.from.name} <${msg.from.address}>` : msg.from.address,
    subject: msg.subject || '(no subject)',
    date: msg.date,
    snippet: msg.snippet || msg.bodyText?.slice(0, 150) || '',
    isRead: msg.flags?.isRead ?? true,
    isStarred: msg.flags?.isStarred ?? false,
    labels: msg.labels,
  };
}

/**
 * Format an email summary for prompt inclusion
 */
function formatEmailForPrompt(email: EmailSummary, index: number): string {
  const flags = [];
  if (!email.isRead) flags.push('UNREAD');
  if (email.isStarred) flags.push('STARRED');

  const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
  const dateStr = email.date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${index + 1}. ${email.subject}${flagStr}
   From: ${email.from}
   Date: ${dateStr}
   ${email.snippet.slice(0, 100)}${email.snippet.length > 100 ? '...' : ''}`;
}

/**
 * Fetch email context from authorized accounts
 *
 * This is the main entry point for getting email context.
 * Returns formatted email summaries ready for prompt inclusion.
 */
export async function fetchEmailContext(options: EmailContextOptions = {}): Promise<EmailContextResult[]> {
  const {
    maxEmails = 5,
    includeRead = false,
    maxAgeHours = 24,
    accounts,
  } = options;

  const providers = await getAuthorizedProviders(accounts);

  if (providers.length === 0) {
    console.log('[EmailContext] No authorized email accounts found');
    return [];
  }

  const results: EmailContextResult[] = [];

  for (const { email, provider, providerType } of providers) {
    try {
      // Determine inbox folder based on provider type
      // Gmail uses 'INBOX', Outlook uses 'inbox'
      const inboxFolder = providerType === 'outlook' ? 'inbox' : 'INBOX';

      // Fetch recent emails from inbox
      const listResult = await provider.listMessages({
        maxResults: maxEmails * 2, // Fetch more to filter
        folder: inboxFolder,
        labelIds: [inboxFolder],
      });

      const recentEmails: EmailSummary[] = [];
      const importantEmails: EmailSummary[] = [];
      let unreadCount = 0;

      for (const msg of listResult.messages) {
        // Filter by age
        if (!isWithinAgeLimit(msg.date, maxAgeHours)) continue;

        // Filter by read status
        if (!includeRead && msg.flags?.isRead) continue;

        const summary = summarizeEmail(msg);

        if (!msg.flags?.isRead) unreadCount++;

        // Categorize - check for starred/flagged or important labels
        const isImportant = msg.flags?.isStarred ||
          msg.labels?.includes('IMPORTANT') ||
          msg.labels?.includes('flagged');

        if (isImportant) {
          importantEmails.push(summary);
        } else {
          recentEmails.push(summary);
        }

        // Respect limits
        if (recentEmails.length >= maxEmails && importantEmails.length >= maxEmails) break;
      }

      results.push({
        account: email,
        providerType,
        unreadCount,
        recentEmails: recentEmails.slice(0, maxEmails),
        importantEmails: importantEmails.slice(0, maxEmails),
      });

    } catch (error) {
      console.error(`[EmailContext] Error fetching from ${email}:`, error);
      // Still add account with empty results to show we tried
      results.push({
        account: email,
        providerType,
        unreadCount: 0,
        recentEmails: [],
        importantEmails: [],
      });
    }
  }

  return results;
}

/**
 * Format email context for heartbeat prompt
 *
 * Returns a formatted string ready to include in the heartbeat prompt.
 * Shows unread counts and recent important emails.
 */
export function formatEmailContextForHeartbeat(context: EmailContextResult[]): string {
  if (context.length === 0) {
    return 'No email accounts available or authorized.';
  }

  const lines: string[] = [];

  for (const account of context) {
    const totalEmails = account.recentEmails.length + account.importantEmails.length;
    const providerLabel = account.providerType !== 'gmail' ? ` [${account.providerType}]` : '';

    if (totalEmails === 0 && account.unreadCount === 0) {
      lines.push(`**${account.account}**${providerLabel}: Inbox clear (no unread in last 24h)`);
      continue;
    }

    lines.push(`**${account.account}**${providerLabel}: ${account.unreadCount} unread`);

    if (account.importantEmails.length > 0) {
      lines.push('\n  Important:');
      account.importantEmails.forEach((email, i) => {
        lines.push('  ' + formatEmailForPrompt(email, i));
      });
    }

    if (account.recentEmails.length > 0) {
      lines.push('\n  Recent:');
      account.recentEmails.slice(0, 3).forEach((email, i) => {
        lines.push('  ' + formatEmailForPrompt(email, i));
      });
    }
  }

  return lines.join('\n');
}

/**
 * Quick check for urgent emails
 *
 * Returns true if there are any unread starred/important emails.
 * Useful for deciding whether to include email context.
 */
export async function hasUrgentEmails(accounts?: string[]): Promise<boolean> {
  const providers = await getAuthorizedProviders(accounts);

  for (const { provider } of providers) {
    try {
      const result = await provider.listMessages({
        maxResults: 10,
        labelIds: ['INBOX'],
      });

      for (const msg of result.messages) {
        if (!msg.flags?.isRead && (msg.flags?.isStarred || msg.labels?.includes('IMPORTANT'))) {
          return true;
        }
      }
    } catch {
      // Ignore errors in urgency check
    }
  }

  return false;
}
