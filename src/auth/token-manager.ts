/**
 * Token Manager Service
 *
 * Unified OAuth token management with encrypted database storage.
 * Supports multiple providers (Google, Microsoft, GitHub, etc.) with automatic refresh.
 * Falls back to file-based token storage when database is unavailable.
 *
 * Usage:
 *   const tokenManager = getTokenManager();
 *   const accessToken = await tokenManager.getAccessToken('google', 'user@example.com');
 */

import { createClient } from '@supabase/supabase-js';
import { encryptJSON, decryptJSON } from '../utils/encryption.ts';
import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

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

// File-based token structure (Google format)
interface FileToken {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  email?: string;
}

// Token directories
const RELAY_DIR = join(process.env.HOME || '~', '.claude-relay');
const GOOGLE_TOKENS_DIR = join(RELAY_DIR, 'google-tokens');
const MICROSOFT_TOKENS_DIR = join(RELAY_DIR, 'microsoft-tokens');

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
  private useDatabase: boolean = true; // Try database first, fall back to files

  constructor() {
    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
    }
  }

  /**
   * Check if database storage is available
   */
  private async isDatabaseAvailable(): Promise<boolean> {
    if (!this.supabase || !this.useDatabase) {
      return false;
    }

    try {
      const { error } = await this.supabase
        .from('oauth_tokens')
        .select('id')
        .limit(1);

      return !error || !error.message.includes('does not exist');
    } catch {
      return false;
    }
  }

  /**
   * Get token file path for a provider/email
   */
  private getTokenFilePath(provider: OAuthProvider, email: string): string | null {
    const safeEmail = email.replace(/[@.]/g, '_');
    switch (provider) {
      case 'google':
        return join(GOOGLE_TOKENS_DIR, `${safeEmail}.json`);
      case 'microsoft':
        return join(MICROSOFT_TOKENS_DIR, `${safeEmail}.json`);
      default:
        return null;
    }
  }

  /**
   * Load token from file system (fallback)
   */
  private async loadTokenFromFile(provider: OAuthProvider, email: string): Promise<FileToken | null> {
    const filePath = this.getTokenFilePath(provider, email);
    if (!filePath || !existsSync(filePath)) {
      return null;
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as FileToken;
    } catch (err) {
      console.error(`[TokenManager] Failed to load token file for ${email}:`, err);
      return null;
    }
  }

  /**
   * Save token to file system
   */
  private async saveTokenToFile(provider: OAuthProvider, email: string, token: OAuthToken): Promise<void> {
    const filePath = this.getTokenFilePath(provider, email);
    if (!filePath) {
      return;
    }

    const fileToken: FileToken = {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expiry_date: token.expiresAt ? token.expiresAt.getTime() : undefined,
      scope: token.scopes.join(' '),
      email,
    };

    try {
      await writeFile(filePath, JSON.stringify(fileToken, null, 2));
      console.log(`[TokenManager] Saved token to file for ${provider}:${email}`);
    } catch (err) {
      console.error(`[TokenManager] Failed to save token file for ${email}:`, err);
    }
  }

  /**
   * Convert file token to stored token format
   */
  private fileTokenToStored(fileToken: FileToken, provider: string, email: string): StoredToken {
    return {
      id: `file-${provider}-${email}`,
      provider,
      email,
      access_token_encrypted: JSON.stringify({ token: fileToken.access_token }), // Not encrypted in file
      refresh_token_encrypted: fileToken.refresh_token ? JSON.stringify({ token: fileToken.refresh_token }) : null,
      token_expiry: fileToken.expiry_date ? new Date(fileToken.expiry_date).toISOString() : null,
      scopes: fileToken.scope ? fileToken.scope.split(' ') : [],
      token_metadata: {},
      is_valid: true,
      error_count: 0,
      last_error: null,
    };
  }

  /**
   * Discover all file-based tokens for a provider
   */
  async discoverFileTokens(provider: OAuthProvider): Promise<Array<{ email: string; token: FileToken }>> {
    const dir = provider === 'google' ? GOOGLE_TOKENS_DIR : provider === 'microsoft' ? MICROSOFT_TOKENS_DIR : null;
    if (!dir || !existsSync(dir)) {
      return [];
    }

    try {
      const files = await readdir(dir);
      const results: Array<{ email: string; token: FileToken }> = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const token = JSON.parse(content) as FileToken;
          if (token.email) {
            results.push({ email: token.email, token });
          }
        } catch {
          // Skip invalid files
        }
      }

      return results;
    } catch {
      return [];
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
    // Always save to file as backup
    await this.saveTokenToFile(provider, email, token);

    // Try database storage if available
    if (await this.isDatabaseAvailable()) {
      // Encrypt tokens
      const accessTokenEncrypted = await encryptJSON({ token: token.accessToken });
      const refreshTokenEncrypted = token.refreshToken
        ? await encryptJSON({ token: token.refreshToken })
        : null;

      // Calculate expiry
      const tokenExpiry = token.expiresAt ? token.expiresAt.toISOString() : null;

      const { error } = await this.supabase!.rpc('upsert_oauth_token', {
        p_provider: provider,
        p_email: email,
        p_access_token_encrypted: accessTokenEncrypted,
        p_refresh_token_encrypted: refreshTokenEncrypted,
        p_token_expiry: tokenExpiry,
        p_scopes: token.scopes,
        p_metadata: token.metadata || {},
      });

      if (error) {
        console.error(`[TokenManager] Database storage failed, file backup saved: ${error.message}`);
      } else {
        console.log(`[TokenManager] Stored token for ${provider}:${email} (database + file)`);
      }
    } else {
      console.log(`[TokenManager] Stored token for ${provider}:${email} (file only - database unavailable)`);
    }
  }

  /**
   * Get a valid access token (with automatic refresh if needed)
   */
  async getAccessToken(provider: OAuthProvider, email: string): Promise<string> {
    let stored: StoredToken | null = null;
    let fromDatabase = false;

    // Try database first
    if (await this.isDatabaseAvailable()) {
      const { data, error } = await this.supabase!.rpc('get_oauth_token', {
        p_provider: provider,
        p_email: email,
      });

      if (!error && data) {
        stored = data as StoredToken;
        fromDatabase = true;
      }
    }

    // Fall back to file-based token
    if (!stored) {
      const fileToken = await this.loadTokenFromFile(provider, email);
      if (fileToken) {
        stored = this.fileTokenToStored(fileToken, provider, email);
        console.log(`[TokenManager] Using file-based token for ${provider}:${email}`);
      }
    }

    if (!stored) {
      throw new Error(`Token not found for ${provider}:${email}`);
    }

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

    // Record usage (if database available)
    if (fromDatabase && this.supabase) {
      await this.supabase.rpc('record_token_usage', {
        p_provider: provider,
        p_email: email,
      }).catch(() => {}); // Ignore errors
    }

    // Decrypt or extract token
    try {
      // Try decrypting (database tokens are encrypted)
      const decrypted = await decryptJSON<{ token: string }>(stored.access_token_encrypted);
      return decrypted.token;
    } catch {
      // Fall back to plain JSON (file tokens are not encrypted)
      try {
        const parsed = JSON.parse(stored.access_token_encrypted);
        return parsed.token;
      } catch {
        // Maybe it's already the raw token
        return stored.access_token_encrypted;
      }
    }
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
      // Decrypt or extract refresh token
      let refreshToken: string;
      try {
        const decrypted = await decryptJSON<{ token: string }>(stored.refresh_token_encrypted);
        refreshToken = decrypted.token;
      } catch {
        // File-based token - not encrypted
        const parsed = JSON.parse(stored.refresh_token_encrypted);
        refreshToken = parsed.token;
      }

      // Call refresh callback
      const result = await refreshCallback(refreshToken);

      // Calculate new expiry
      const expiresAt = new Date(Date.now() + result.expiresIn * 1000);

      // Store new token (saves to both database and file)
      await this.storeToken(provider as OAuthProvider, email, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || refreshToken,
        expiresAt,
        scopes: stored.scopes,
      });

      return result.accessToken;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Try to record error in database
      if (await this.isDatabaseAvailable()) {
        await this.supabase!.rpc('record_token_error', {
          p_provider: provider,
          p_email: email,
          p_error: errorMessage,
          p_invalidate: true,
        }).catch(() => {}); // Ignore errors
      }

      throw new Error(`Token refresh failed for ${provider}:${email}: ${errorMessage}`);
    }
  }

  /**
   * Get all valid tokens for a provider
   */
  async getValidTokens(provider: OAuthProvider): Promise<Array<{ email: string; accessToken: string }>> {
    const results: Array<{ email: string; accessToken: string }> = [];

    // Try database first
    if (await this.isDatabaseAvailable()) {
      const { data, error } = await this.supabase!.rpc('get_valid_oauth_tokens', {
        p_provider: provider,
      });

      if (!error && data) {
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
    }

    // Fall back to file-based tokens
    const fileTokens = await this.discoverFileTokens(provider);
    for (const { email, token } of fileTokens) {
      // Check if token is expired
      if (token.expiry_date && token.expiry_date < Date.now()) {
        continue; // Skip expired tokens
      }
      results.push({
        email,
        accessToken: token.access_token,
      });
    }

    return results;
  }

  /**
   * Check if a token exists
   */
  async hasToken(provider: OAuthProvider, email: string): Promise<boolean> {
    // Check database first
    if (await this.isDatabaseAvailable()) {
      const { data, error } = await this.supabase!.rpc('get_oauth_token', {
        p_provider: provider,
        p_email: email,
      });

      if (!error && data) {
        return true;
      }
    }

    // Fall back to file check
    const fileToken = await this.loadTokenFromFile(provider, email);
    return fileToken !== null;
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
