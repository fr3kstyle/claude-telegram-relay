/**
 * Token Manager Service
 *
 * Unified OAuth token management with encrypted database storage.
 * Supports multiple providers (Google, Microsoft, etc.) with automatic refresh.
 *
 * Usage:
 *   const tokenManager = getTokenManager();
 *   const accessToken = await tokenManager.getAccessToken('google', 'user@example.com');
 */

import { createClient } from '@supabase/supabase-js';
import { encryptJSON, decryptJSON } from '../utils/encryption.ts';

// Provider types
export type OAuthProvider = 'google' | 'microsoft' | 'github' | 'custom';

// Token structure (decrypted)
export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  metadata?: Record<string, unknown>;
}

// Stored token from database
interface StoredToken {
  id: string;
  provider: string;
  email: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expiry: string | null;
  scopes: string[];
  token_metadata: Record<string, unknown>;
  is_valid: boolean;
  error_count: number;
  last_error: string | null;
}

// Refresh callback type
type RefreshCallback = (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }>;

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

/**
 * Token Manager Class
 */
export class TokenManager {
  private supabase: ReturnType<typeof createClient> | null = null;
  private refreshCallbacks: Map<string, RefreshCallback> = new Map();
  private refreshPromises: Map<string, Promise<string>> = new Map();

  constructor() {
    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
    }
  }

  /**
   * Register a refresh callback for a provider
   */
  registerRefreshCallback(provider: OAuthProvider, callback: RefreshCallback): void {
    this.refreshCallbacks.set(provider, callback);
  }

  /**
   * Store a new OAuth token
   */
  async storeToken(
    provider: OAuthProvider,
    email: string,
    token: OAuthToken
  ): Promise<void> {
    if (!this.supabase) {
      throw new Error('Supabase not configured');
    }

    // Encrypt tokens
    const accessTokenEncrypted = await encryptJSON({ token: token.accessToken });
    const refreshTokenEncrypted = token.refreshToken
      ? await encryptJSON({ token: token.refreshToken })
      : null;

    // Calculate expiry
    const tokenExpiry = token.expiresAt ? token.expiresAt.toISOString() : null;

    const { error } = await this.supabase.rpc('upsert_oauth_token', {
      p_provider: provider,
      p_email: email,
      p_access_token_encrypted: accessTokenEncrypted,
      p_refresh_token_encrypted: refreshTokenEncrypted,
      p_token_expiry: tokenExpiry,
      p_scopes: token.scopes,
      p_metadata: token.metadata || {},
    });

    if (error) {
      throw new Error(`Failed to store token: ${error.message}`);
    }

    console.log(`[TokenManager] Stored token for ${provider}:${email}`);
  }

  /**
   * Get a valid access token (with automatic refresh if needed)
   */
  async getAccessToken(provider: OAuthProvider, email: string): Promise<string> {
    if (!this.supabase) {
      throw new Error('Supabase not configured');
    }

    // Get stored token
    const { data, error } = await this.supabase.rpc('get_oauth_token', {
      p_provider: provider,
      p_email: email,
    });

    if (error || !data) {
      throw new Error(`Token not found for ${provider}:${email}`);
    }

    const stored = data as StoredToken;

    if (!stored.is_valid) {
      throw new Error(`Token is invalid for ${provider}:${email}: ${stored.last_error}`);
    }

    // Check if token needs refresh
    const needsRefresh = this.tokenNeedsRefresh(stored);

    if (needsRefresh) {
      // Use existing refresh promise to prevent concurrent refreshes
      const cacheKey = `${provider}:${email}`;

      if (this.refreshPromises.has(cacheKey)) {
        return this.refreshPromises.get(cacheKey)!;
      }

      const refreshPromise = this.refreshToken(provider, email, stored);
      this.refreshPromises.set(cacheKey, refreshPromise);

      try {
        const newAccessToken = await refreshPromise;
        return newAccessToken;
      } finally {
        this.refreshPromises.delete(cacheKey);
      }
    }

    // Record usage and decrypt
    await this.supabase.rpc('record_token_usage', {
      p_provider: provider,
      p_email: email,
    });

    const decrypted = await decryptJSON<{ token: string }>(stored.access_token_encrypted);
    return decrypted.token;
  }

  /**
   * Check if token needs refresh (expired or expiring within 5 minutes)
   */
  private tokenNeedsRefresh(stored: StoredToken): boolean {
    if (!stored.token_expiry) {
      return false; // No expiry, assume valid
    }

    const expiry = new Date(stored.token_expiry);
    const now = new Date();
    const buffer = 5 * 60 * 1000; // 5 minutes

    return expiry.getTime() - now.getTime() < buffer;
  }

  /**
   * Refresh an expired token
   */
  private async refreshToken(
    provider: string,
    email: string,
    stored: StoredToken
  ): Promise<string> {
    const refreshCallback = this.refreshCallbacks.get(provider);

    if (!refreshCallback) {
      throw new Error(`No refresh callback registered for ${provider}`);
    }

    if (!stored.refresh_token_encrypted) {
      throw new Error(`No refresh token for ${provider}:${email}`);
    }

    console.log(`[TokenManager] Refreshing token for ${provider}:${email}`);

    try {
      // Decrypt refresh token
      const decrypted = await decryptJSON<{ token: string }>(stored.refresh_token_encrypted);
      const refreshToken = decrypted.token;

      // Call refresh callback
      const result = await refreshCallback(refreshToken);

      // Calculate new expiry
      const expiresAt = new Date(Date.now() + result.expiresIn * 1000);

      // Store new token
      await this.storeToken(provider as OAuthProvider, email, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt,
        scopes: stored.scopes,
      });

      return result.accessToken;
    } catch (err) {
      // Record error
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.supabase!.rpc('record_token_error', {
        p_provider: provider,
        p_email: email,
        p_error: errorMessage,
        p_invalidate: true,
      });

      throw new Error(`Token refresh failed for ${provider}:${email}: ${errorMessage}`);
    }
  }

  /**
   * Get all valid tokens for a provider
   */
  async getValidTokens(provider: OAuthProvider): Promise<Array<{ email: string; accessToken: string }>> {
    if (!this.supabase) {
      return [];
    }

    const { data, error } = await this.supabase.rpc('get_valid_oauth_tokens', {
      p_provider: provider,
    });

    if (error || !data) {
      return [];
    }

    const results: Array<{ email: string; accessToken: string }> = [];

    for (const stored of data as StoredToken[]) {
      try {
        const decrypted = await decryptJSON<{ token: string }>(stored.access_token_encrypted);
        results.push({
          email: stored.email,
          accessToken: decrypted.token,
        });
      } catch (err) {
        console.error(`[TokenManager] Failed to decrypt token for ${stored.email}:`, err);
      }
    }

    return results;
  }

  /**
   * Check if a token exists
   */
  async hasToken(provider: OAuthProvider, email: string): Promise<boolean> {
    if (!this.supabase) {
      return false;
    }

    const { data, error } = await this.supabase.rpc('get_oauth_token', {
      p_provider: provider,
      p_email: email,
    });

    return !error && !!data;
  }

  /**
   * Invalidate a token
   */
  async invalidateToken(provider: OAuthProvider, email: string, reason: string): Promise<void> {
    if (!this.supabase) {
      return;
    }

    await this.supabase.rpc('record_token_error', {
      p_provider: provider,
      p_email: email,
      p_error: reason,
      p_invalidate: true,
    });

    console.log(`[TokenManager] Invalidated token for ${provider}:${email}: ${reason}`);
  }

  /**
   * Delete a token
   */
  async deleteToken(provider: OAuthProvider, email: string): Promise<void> {
    if (!this.supabase) {
      return;
    }

    const { error } = await this.supabase
      .from('oauth_tokens')
      .delete()
      .eq('provider', provider)
      .eq('email', email);

    if (error) {
      throw new Error(`Failed to delete token: ${error.message}`);
    }

    console.log(`[TokenManager] Deleted token for ${provider}:${email}`);
  }

  /**
   * Get tokens expiring soon (for proactive refresh)
   */
  async getTokensExpiringSoon(withinHours: number = 1): Promise<Array<{ provider: string; email: string }>> {
    if (!this.supabase) {
      return [];
    }

    const { data, error } = await this.supabase.rpc('get_tokens_expiring_soon', {
      p_within_hours: withinHours,
    });

    if (error || !data) {
      return [];
    }

    return (data as StoredToken[]).map(t => ({
      provider: t.provider,
      email: t.email,
    }));
  }
}

// Singleton instance
let tokenManagerInstance: TokenManager | null = null;

/**
 * Get the singleton TokenManager instance
 */
export function getTokenManager(): TokenManager {
  if (!tokenManagerInstance) {
    tokenManagerInstance = new TokenManager();
  }
  return tokenManagerInstance;
}
