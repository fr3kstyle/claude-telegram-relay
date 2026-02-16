/**
 * Email Sync Module
 *
 * Synchronizes emails from Gmail/Outlook to Supabase with embeddings for semantic search.
 * Uses provider abstraction via GmailProvider/OutlookProvider with encrypted TokenManager.
 *
 * Usage:
 *   import { syncEmails, searchEmails, getRecentEmails } from './email-sync';
 *   await syncEmails('Fr3kchy@gmail.com');
 *   const results = await searchEmails('important meeting');
 */

import { createClient } from "@supabase/supabase-js";
import { getEmailProviderFactory, type EmailProviderFactory } from "./email/provider-factory.ts";
import type { EmailProvider, EmailMessage, EmailAccountConfig } from "./email/types.ts";
import { existsSync } from "fs";
import { join } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");

// Cache for provider instances
let providerFactory: EmailProviderFactory | null = null;

function getProviderFactory(): EmailProviderFactory {
  if (!providerFactory) {
    providerFactory = getEmailProviderFactory();
  }
  return providerFactory;
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// ============================================================
// TYPES
// ============================================================

export interface EmailAccount {
  id: string;
  email: string;
  display_name: string | null;
  provider: string;
  is_active: boolean;
  sync_enabled: boolean;
  last_sync_at: string | null;
}

export interface EmailSyncResult {
  account: string;
  messagesSynced: number;
  errors: string[];
}

export interface StoredEmail {
  id: string;
  gmail_id: string; // Kept for backward compatibility, now stores provider message ID
  thread_id: string | null;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  date: string | null;
  snippet: string | null;
  body_text: string | null;
  is_read: boolean;
  is_starred: boolean;
}

// Provider message to StoredEmail converter
function emailMessageToStored(msg: EmailMessage): StoredEmail {
  return {
    id: msg.id,
    gmail_id: msg.id, // Use provider message ID
    thread_id: msg.threadId || null,
    subject: msg.subject || null,
    from_email: msg.from?.address || null,
    from_name: msg.from?.name || null,
    date: msg.date?.toISOString() || null,
    snippet: msg.snippet?.substring(0, 500) || null,
    body_text: msg.bodyText?.substring(0, 10000) || null,
    is_read: msg.flags?.isRead ?? true,
    is_starred: msg.flags?.isStarred ?? false,
  };
}

// ============================================================
// ACCOUNT MANAGEMENT
// ============================================================

/**
 * Get or create an email account record
 */
export async function getOrCreateAccount(
  email: string
): Promise<EmailAccount | null> {
  // Try to get existing account
  const { data: existing, error: selectError } = await supabase
    .from("email_accounts")
    .select("*")
    .eq("email", email)
    .single();

  if (existing) return existing as EmailAccount;

  // Table doesn't exist yet - return a mock account
  if (selectError?.message?.includes("does not exist")) {
    console.log(
      "[Email] email_accounts table not found - run migration first"
    );
    return {
      id: "mock-" + email,
      email,
      display_name: email.split("@")[0],
      provider: "gmail",
      is_active: true,
      sync_enabled: true,
      last_sync_at: null,
    };
  }

  // Create new account
  const { data: newAccount, error: insertError } = await supabase
    .from("email_accounts")
    .insert({
      email,
      display_name: email.split("@")[0],
      provider: "gmail",
      is_active: true,
      sync_enabled: true,
    })
    .select()
    .single();

  if (insertError) {
    console.error(`[Email] Failed to create account for ${email}:`, insertError.message);
    return null;
  }

  // Create sync state
  await supabase.from("email_sync_state").insert({
    account_id: newAccount.id,
  });

  return newAccount as EmailAccount;
}

/**
 * Get all active email accounts
 */
export async function getActiveAccounts(): Promise<EmailAccount[]> {
  const { data, error } = await supabase
    .from("email_accounts")
    .select("*")
    .eq("is_active", true)
    .eq("sync_enabled", true);

  if (error) {
    if (error.message.includes("does not exist")) {
      // Return mock accounts from fallback accounts via provider factory
      const factory = getProviderFactory();
      const accounts = await factory.discoverAccounts();
      return accounts.map((acc) => ({
        id: acc.id,
        email: acc.emailAddress,
        display_name: acc.displayName || acc.emailAddress.split("@")[0],
        provider: acc.providerType,
        is_active: acc.isActive,
        sync_enabled: acc.syncEnabled,
        last_sync_at: null,
      }));
    }
    console.error("[Email] Failed to get accounts:", error.message);
    return [];
  }

  return (data as EmailAccount[]) || [];
}

// ============================================================
// EMAIL SYNC
// ============================================================

/**
 * Parse email address from "Name <email@domain.com>" format
 */
function parseEmailAddress(from: string | undefined): {
  email: string | null;
  name: string | null;
} {
  if (!from) return { email: null, name: null };

  const match = from.match(/(?:"?([^"<]+)"?\s*)?(?:<)?([^>\s@]+@[^>\s@]+)(?:>)?/);
  if (match) {
    return {
      name: match[1]?.trim() || null,
      email: match[2]?.toLowerCase() || null,
    };
  }
  return { email: from.toLowerCase(), name: null };
}

/**
 * Sync emails for a specific account
 */
export async function syncEmails(
  email: string,
  options: { maxResults?: number; force?: boolean } = {}
): Promise<EmailSyncResult> {
  const { maxResults = 50, force = false } = options;
  const result: EmailSyncResult = {
    account: email,
    messagesSynced: 0,
    errors: [],
  };

  try {
    // Get account
    const account = await getOrCreateAccount(email);
    if (!account) {
      result.errors.push("Failed to get/create account");
      return result;
    }

    // Check if we need to sync
    if (!force && account.last_sync_at) {
      const lastSync = new Date(account.last_sync_at);
      const hoursSinceSync =
        (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
      if (hoursSinceSync < 1) {
        console.log(`[Email] ${email} synced recently, skipping`);
        return result;
      }
    }

    // Get provider from factory
    const factory = getProviderFactory();
    const provider = await factory.getProvider(email);

    if (!provider) {
      result.errors.push(`No provider available for ${email}`);
      return result;
    }

    // Verify authentication
    if (!(await provider.isAuthenticated())) {
      result.errors.push(`Account not authenticated: ${email}`);
      return result;
    }

    // Fetch emails from provider
    console.log(`[Email] Fetching emails for ${email}...`);
    const messagesResult = await provider.listMessages({ maxResults });
    const messages = messagesResult.messages;
    console.log(`[Email] Found ${messages.length} messages`);

    // Check if table exists
    const { error: tableCheck } = await supabase
      .from("email_messages")
      .select("id")
      .limit(1);

    if (tableCheck && (tableCheck.message?.includes("does not exist") || tableCheck.message?.includes("Could not find"))) {
      result.errors.push(
        "email_messages table not found - run migration first"
      );
      return result;
    }

    // Store messages
    for (const msg of messages) {
      const emailData = {
        account_id: account.id,
        gmail_id: msg.id, // Kept for backward compatibility
        thread_id: msg.threadId || null,
        subject: msg.subject || null,
        from_email: msg.from?.address || null,
        from_name: msg.from?.name || null,
        to_recipients: msg.to?.map(a => ({ email: a.address, name: a.name })) || [],
        date: msg.date ? new Date(msg.date).toISOString() : null,
        snippet: msg.snippet?.substring(0, 500) || null,
        body_text: msg.bodyText?.substring(0, 10000) || null,
        is_read: msg.flags?.isRead ?? true,
        is_starred: msg.flags?.isStarred ?? false,
      };

      const { error: upsertError } = await supabase
        .from("email_messages")
        .upsert(emailData, {
          onConflict: "account_id,gmail_id",
        });

      if (upsertError) {
        result.errors.push(`Failed to store message ${msg.id}: ${upsertError.message}`);
      } else {
        result.messagesSynced++;
      }
    }

    // Update sync state
    await supabase
      .from("email_accounts")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", account.id);

    console.log(
      `[Email] Synced ${result.messagesSynced} messages for ${email}`
    );
  } catch (error: any) {
    result.errors.push(error.message);
    console.error(`[Email] Sync failed for ${email}:`, error.message);
  }

  return result;
}

/**
 * Sync all active accounts
 */
export async function syncAllAccounts(): Promise<EmailSyncResult[]> {
  const accounts = await getActiveAccounts();
  const results: EmailSyncResult[] = [];

  for (const account of accounts) {
    const result = await syncEmails(account.email);
    results.push(result);
  }

  return results;
}

// ============================================================
// EMAIL SEARCH
// ============================================================

/**
 * Search emails using full-text search
 */
export async function searchEmails(
  query: string,
  options: { accountId?: string; limit?: number } = {}
): Promise<StoredEmail[]> {
  const { accountId, limit = 10 } = options;

  // Check if table exists
  const { error: tableCheck } = await supabase
    .from("email_messages")
    .select("id")
    .limit(1);

  if (tableCheck && (tableCheck.message?.includes("does not exist") || tableCheck.message?.includes("Could not find"))) {
    // Fallback to provider API search
    console.log("[Email] Table not found, using provider API search");
    const factory = getProviderFactory();
    const accounts = await factory.discoverAccounts();
    const allResults: StoredEmail[] = [];

    for (const account of accounts) {
      try {
        const provider = factory.createProvider(account.providerType, account.emailAddress);
        if (!(await provider.isAuthenticated())) continue;

        const messages = await provider.searchMessages({ query, maxResults: limit });
        for (const msg of messages.messages) {
          allResults.push(emailMessageToStored(msg));
        }
      } catch (e: any) {
        console.error(`[Email] Provider search failed for ${account.emailAddress}:`, e.message);
      }
    }

    return allResults.slice(0, limit);
  }

  // Use database full-text search
  const { data, error } = await supabase.rpc("search_emails_text", {
    p_query: query,
    p_account_id: accountId || null,
    p_match_count: limit,
  });

  if (error) {
    console.error("[Email] Search failed:", error.message);
    return [];
  }

  return (data as StoredEmail[]) || [];
}

/**
 * Get recent emails
 */
export async function getRecentEmails(
  options: { accountId?: string; limit?: number; unreadOnly?: boolean } = {}
): Promise<StoredEmail[]> {
  const { accountId, limit = 20, unreadOnly = false } = options;

  // Check if table exists
  const { error: tableCheck } = await supabase
    .from("email_messages")
    .select("id")
    .limit(1);

  if (tableCheck && (tableCheck.message?.includes("does not exist") || tableCheck.message?.includes("Could not find"))) {
    // Fallback to provider API
    console.log("[Email] Table not found, using provider API");
    const factory = getProviderFactory();
    const accounts = await factory.discoverAccounts();
    const allResults: StoredEmail[] = [];

    for (const account of accounts) {
      try {
        const provider = factory.createProvider(account.providerType, account.emailAddress);
        if (!(await provider.isAuthenticated())) continue;

        const messages = await provider.listMessages({
          maxResults: limit,
          labelIds: unreadOnly ? ["UNREAD"] : undefined,
        });
        for (const msg of messages.messages) {
          allResults.push(emailMessageToStored(msg));
        }
      } catch (e: any) {
        console.error(`[Email] Provider fetch failed for ${account.emailAddress}:`, e.message);
      }
    }

    // Sort by date and limit
    return allResults
      .sort((a, b) => {
        if (!a.date || !b.date) return 0;
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      })
      .slice(0, limit);
  }

  // Query from database
  let query = supabase
    .from("email_messages")
    .select(
      "id, gmail_id, thread_id, subject, from_email, from_name, date, snippet, body_text, is_read, is_starred"
    )
    .order("date", { ascending: false })
    .limit(limit);

  if (accountId) {
    query = query.eq("account_id", accountId);
  }

  if (unreadOnly) {
    query = query.eq("is_read", false);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[Email] Failed to get recent emails:", error.message);
    return [];
  }

  return (data as StoredEmail[]) || [];
}

/**
 * Get unread email count
 */
export async function getUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from("email_messages")
    .select("*", { count: "exact", head: true })
    .eq("is_read", false);

  if (error) {
    // Fallback to provider API
    const factory = getProviderFactory();
    const accounts = await factory.discoverAccounts();
    let total = 0;
    for (const account of accounts) {
      try {
        const provider = factory.createProvider(account.providerType, account.emailAddress);
        if (!(await provider.isAuthenticated())) continue;

        const messages = await provider.listMessages({
          maxResults: 50,
          labelIds: ["UNREAD"],
        });
        total += messages.messages.length;
      } catch (e) {
        // Ignore errors
      }
    }
    return total;
  }

  return count || 0;
}

// ============================================================
// CLI
// ============================================================

async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case "sync":
      const email = args[1];
      if (email) {
        const result = await syncEmails(email, { force: true });
        console.log(JSON.stringify(result, null, 2));
      } else {
        const results = await syncAllAccounts();
        console.log(JSON.stringify(results, null, 2));
      }
      break;

    case "search":
      const query = args[1];
      if (!query) {
        console.log("Usage: bun run src/email-sync.ts search <query>");
        process.exit(1);
      }
      const results = await searchEmails(query);
      console.log(JSON.stringify(results, null, 2));
      break;

    case "recent":
      const recent = await getRecentEmails({ limit: 10 });
      console.log(JSON.stringify(recent, null, 2));
      break;

    case "unread":
      const unread = await getRecentEmails({ unreadOnly: true, limit: 10 });
      console.log(JSON.stringify(unread, null, 2));
      break;

    default:
      console.log("Email Sync Module");
      console.log("");
      console.log("Commands:");
      console.log("  sync [email]  - Sync emails (all accounts or specific)");
      console.log("  search <query> - Search emails");
      console.log("  recent        - Get recent emails");
      console.log("  unread        - Get unread emails");
  }
}

// Run CLI if executed directly
if (
  import.meta.path === process.argv[1] ||
  (process.argv[1] && process.argv[1].endsWith("email-sync.ts"))
) {
  cli().catch(console.error);
}

export default {
  syncEmails,
  syncAllAccounts,
  searchEmails,
  getRecentEmails,
  getUnreadCount,
  getActiveAccounts,
  getOrCreateAccount,
};
