/**
 * Email Provider Factory
 *
 * Factory for creating email provider instances based on account configuration.
 * Supports provider registration, auto-discovery, and account management.
 */

import { createClient } from '@supabase/supabase-js';
import { GmailProvider, createGmailProvider } from './gmail-provider.ts';
import { OutlookProvider, createOutlookProvider } from './outlook-provider.ts';
import type {
  EmailProvider,
  EmailProviderType,
  EmailAccountConfig,
  ProviderCapabilities,
} from './types.ts';

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

/**
 * Provider Constructor Type
 */
type ProviderConstructor = new (email: string) => EmailProvider;

/**
 * Provider Registry Entry
 */
interface ProviderRegistryEntry {
  type: EmailProviderType;
  constructor: ProviderConstructor;
  factory?: (email: string) => EmailProvider;
  capabilities: ProviderCapabilities;
}

/**
 * Email Provider Factory
 *
 * Manages provider registration and instance creation.
 */
export class EmailProviderFactory {
  private registry: Map<EmailProviderType, ProviderRegistryEntry> = new Map();
  private instances: Map<string, EmailProvider> = new Map();
  private supabase: ReturnType<typeof createClient> | null = null;

  constructor() {
    // Register built-in providers
    this.registerGmailProvider();
    this.registerOutlookProvider();
  }

  /**
   * Register Gmail provider
   */
  private registerGmailProvider(): void {
    this.register({
      type: 'gmail',
      factory: createGmailProvider,
      capabilities: {
        canSend: true,
        canSearch: true,
        canModifyLabels: true,
        canMoveToFolder: true,
        supportsThreads: true,
        supportsDrafts: true,
        maxAttachmentSize: 25 * 1024 * 1024, // 25MB
      },
    });
  }

  /**
   * Register Outlook provider
   */
  private registerOutlookProvider(): void {
    this.register({
      type: 'outlook',
      factory: createOutlookProvider,
      capabilities: {
        canSend: true,
        canSearch: true,
        canModifyLabels: false, // Outlook uses folders, not labels
        canMoveToFolder: true,
        supportsThreads: true, // Via conversationId
        supportsDrafts: true,
        maxAttachmentSize: 25 * 1024 * 1024, // 25MB
      },
    });
  }

  /**
   * Register a provider type
   */
  register(entry: Omit<ProviderRegistryEntry, 'constructor'> & { constructor?: ProviderConstructor }): void {
    const fullEntry: ProviderRegistryEntry = {
      type: entry.type,
      constructor: entry.constructor ?? (class DummyProvider implements EmailProvider {
        constructor(private email: string) {}
        async getProviderInfo() { return { type: entry.type, emailAddress: this.email, capabilities: entry.capabilities }; }
        async authenticate() { throw new Error('Not implemented'); }
        async isAuthenticated() { return false; }
        async listMessages() { return { messages: [] }; }
        async getMessage() { throw new Error('Not implemented'); }
        async getMessages() { return []; }
        async sendMessage() { throw new Error('Not implemented'); }
        async searchMessages() { return { messages: [] }; }
        async markAsRead() { throw new Error('Not implemented'); }
        async markAsUnread() { throw new Error('Not implemented'); }
        async starMessage() { throw new Error('Not implemented'); }
        async unstarMessage() { throw new Error('Not implemented'); }
        async trashMessage() { throw new Error('Not implemented'); }
        async deleteMessage() { throw new Error('Not implemented'); }
        async getLabels() { return []; }
      }),
      factory: entry.factory,
      capabilities: entry.capabilities,
    };
    this.registry.set(entry.type, fullEntry);
  }

  /**
   * Get Supabase client (lazy initialization)
   */
  private getSupabase(): ReturnType<typeof createClient> | null {
    if (!this.supabase && supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
    }
    return this.supabase;
  }

  /**
   * Create a provider instance for an account
   */
  createProvider(type: EmailProviderType, emailAddress: string): EmailProvider {
    // Check cache first
    const cacheKey = `${type}:${emailAddress}`;
    const cached = this.instances.get(cacheKey);
    if (cached) {
      return cached;
    }

    const entry = this.registry.get(type);
    if (!entry) {
      throw new Error(`Unknown email provider type: ${type}`);
    }

    // Use factory function if available, otherwise constructor
    const provider = entry.factory
      ? entry.factory(emailAddress)
      : new entry.constructor(emailAddress);

    // Cache the instance
    this.instances.set(cacheKey, provider);

    return provider;
  }

  /**
   * Get or create a Gmail provider
   */
  getGmailProvider(email: string): GmailProvider {
    return this.createProvider('gmail', email) as GmailProvider;
  }

  /**
   * Get or create an Outlook provider
   */
  getOutlookProvider(email: string): OutlookProvider {
    return this.createProvider('outlook', email) as OutlookProvider;
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(type: EmailProviderType): ProviderCapabilities | undefined {
    return this.registry.get(type)?.capabilities;
  }

  /**
   * Check if a provider type is registered
   */
  isRegistered(type: EmailProviderType): boolean {
    return this.registry.has(type);
  }

  /**
   * Get all registered provider types
   */
  getRegisteredTypes(): EmailProviderType[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Clear the provider instance cache
   */
  clearCache(): void {
    this.instances.clear();
  }

  /**
   * Discover accounts from database
   *
   * Queries the email_accounts table to find all configured accounts.
   */
  async discoverAccounts(): Promise<EmailAccountConfig[]> {
    const db = this.getSupabase();
    if (!db) {
      console.warn('[ProviderFactory] Supabase not configured, using fallback accounts');
      return this.getFallbackAccounts();
    }

    const { data, error } = await db
      .from('email_accounts')
      .select('*')
      .eq('is_active', true)
      .eq('sync_enabled', true);

    if (error) {
      console.error('[ProviderFactory] Failed to discover accounts:', error.message);
      return this.getFallbackAccounts();
    }

    if (!data || data.length === 0) {
      console.log('[ProviderFactory] No accounts in database, using fallback');
      return this.getFallbackAccounts();
    }

    return data.map((row) => ({
      id: row.id,
      providerType: row.provider as EmailProviderType,
      emailAddress: row.email,
      displayName: row.display_name || undefined,
      isActive: row.is_active,
      syncEnabled: row.sync_enabled,
    }));
  }

  /**
   * Get fallback accounts when database is unavailable
   *
   * Returns empty array - all accounts should be discovered from the database.
   * This ensures a single source of truth and prevents hardcoded account drift.
   */
  private getFallbackAccounts(): EmailAccountConfig[] {
    console.warn('[ProviderFactory] Database unavailable, no fallback accounts');
    return [];
  }

  /**
   * Create providers for all discovered accounts
   *
   * Returns providers that successfully authenticate.
   */
  async createProvidersForAccounts(accounts?: EmailAccountConfig[]): Promise<Map<string, EmailProvider>> {
    const accountsToUse = accounts || await this.discoverAccounts();
    const providers = new Map<string, EmailProvider>();

    for (const account of accountsToUse) {
      if (!account.isActive || !account.syncEnabled) {
        continue;
      }

      try {
        const provider = this.createProvider(account.providerType, account.emailAddress);

        // Verify authentication
        if (await provider.isAuthenticated()) {
          providers.set(account.emailAddress, provider);
        } else {
          console.warn(`[ProviderFactory] Account not authenticated: ${account.emailAddress}`);
        }
      } catch (error) {
        console.error(`[ProviderFactory] Failed to create provider for ${account.emailAddress}:`, error);
      }
    }

    return providers;
  }

  /**
   * Register a new email account in the database
   *
   * Called after OAuth flow completes successfully.
   */
  async registerAccount(options: {
    emailAddress: string;
    providerType: EmailProviderType;
    displayName?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const db = this.getSupabase();
    if (!db) {
      return { success: false, error: 'Database not configured' };
    }

    try {
      // Check if account already exists
      const { data: existing, error: checkError } = await db
        .from('email_accounts')
        .select('id')
        .eq('email', options.emailAddress)
        .maybeSingle();

      if (checkError && checkError.code !== 'PGRST116') {
        return { success: false, error: checkError.message };
      }

      if (existing) {
        // Update existing account to active
        const { error: updateError } = await db
          .from('email_accounts')
          .update({
            is_active: true,
            sync_enabled: true,
            display_name: options.displayName || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        if (updateError) {
          return { success: false, error: updateError.message };
        }

        console.log(`[ProviderFactory] Updated account: ${options.emailAddress}`);
        return { success: true };
      }

      // Insert new account
      const { error: insertError } = await db
        .from('email_accounts')
        .insert({
          email: options.emailAddress,
          provider: options.providerType,
          display_name: options.displayName || null,
          is_active: true,
          sync_enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (insertError) {
        return { success: false, error: insertError.message };
      }

      console.log(`[ProviderFactory] Registered new account: ${options.emailAddress}`);
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Remove an email account from the database and delete local tokens
   *
   * Marks account as inactive in database and removes token file.
   */
  async removeAccount(emailAddress: string): Promise<{ success: boolean; error?: string }> {
    const db = this.getSupabase();
    const normalizedEmail = emailAddress.toLowerCase().trim();

    // Delete local token file
    const tokenPath = `${process.env.RELAY_DIR || `${process.env.HOME}/.claude-relay`}/tokens/${normalizedEmail}.json`;
    try {
      const fs = await import('fs/promises');
      await fs.unlink(tokenPath).catch(() => {
        // File may not exist, that's okay
      });
      console.log(`[ProviderFactory] Deleted token file for ${normalizedEmail}`);
    } catch (err) {
      // Non-fatal - continue with database removal
      console.warn(`[ProviderFactory] Could not delete token file: ${err}`);
    }

    // Remove from instance cache (clear all providers for this email)
    for (const key of this.instances.keys()) {
      if (key.endsWith(`:${normalizedEmail}`)) {
        this.instances.delete(key);
      }
    }

    // Mark as inactive in database (or delete entirely)
    if (!db) {
      return { success: true }; // No database, file removal only
    }

    try {
      const { error } = await db
        .from('email_accounts')
        .update({
          is_active: false,
          sync_enabled: false,
          updated_at: new Date().toISOString(),
        })
        .eq('email', normalizedEmail);

      if (error) {
        return { success: false, error: error.message };
      }

      console.log(`[ProviderFactory] Removed account: ${normalizedEmail}`);
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get a single provider by email address
   *
   * Discovers the account from the database or creates from fallback.
   */
  async getProvider(emailAddress: string): Promise<EmailProvider | null> {
    const db = this.getSupabase();

    // Try to get account from database
    if (db) {
      const { data, error } = await db
        .from('email_accounts')
        .select('*')
        .eq('email', emailAddress)
        .eq('is_active', true)
        .single();

      if (!error && data) {
        return this.createProvider(data.provider as EmailProviderType, emailAddress);
      }

      if (error) {
        console.error(`[ProviderFactory] Database lookup failed for ${emailAddress}:`, error.message);
      }
    }

    // No fallback - account must exist in database
    console.warn(`[ProviderFactory] No account found for ${emailAddress}`);
    return null;
  }
}

// Singleton instance
let factoryInstance: EmailProviderFactory | null = null;

/**
 * Get the singleton factory instance
 */
export function getEmailProviderFactory(): EmailProviderFactory {
  if (!factoryInstance) {
    factoryInstance = new EmailProviderFactory();
  }
  return factoryInstance;
}

/**
 * Create an email provider (convenience function)
 */
export function createEmailProvider(type: EmailProviderType, emailAddress: string): EmailProvider {
  return getEmailProviderFactory().createProvider(type, emailAddress);
}

/**
 * Get all authorized providers (convenience function)
 */
export async function getAuthorizedProviders(): Promise<Map<string, EmailProvider>> {
  return getEmailProviderFactory().createProvidersForAccounts();
}
