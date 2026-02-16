/**
 * Email Provider Factory
 *
 * Factory for creating email provider instances based on account configuration.
 * Supports provider registration, auto-discovery, and account management.
 */

import { createClient } from '@supabase/supabase-js';
import { GmailProvider, createGmailProvider } from './gmail-provider.ts';
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
   */
  private getFallbackAccounts(): EmailAccountConfig[] {
    return [
      {
        id: 'fallback-1',
        providerType: 'gmail',
        emailAddress: 'Fr3kchy@gmail.com',
        displayName: 'Fr3kchy Gmail',
        isActive: true,
        syncEnabled: true,
      },
      {
        id: 'fallback-2',
        providerType: 'gmail',
        emailAddress: 'fr3k@mcpintelligence.com.au',
        displayName: 'MCP Intelligence',
        isActive: true,
        syncEnabled: true,
      },
    ];
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
    }

    // Fallback: assume Gmail
    if (this.isRegistered('gmail')) {
      return this.createProvider('gmail', emailAddress);
    }

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
