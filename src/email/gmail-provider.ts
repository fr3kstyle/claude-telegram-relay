/**
 * Gmail Provider Implementation
 *
 * Implements EmailProvider interface using Gmail API.
 * Uses encrypted OAuth tokens from TokenManager with database storage.
 */

import { getTokenManager } from '../auth/token-manager.ts';
import type {
  EmailProvider,
  EmailMessage,
  EmailAddress,
  ListMessagesOptions,
  ListMessagesResult,
  SendMessageOptions,
  SearchMessagesOptions,
  ProviderInfo,
  ProviderCapabilities,
  EmailFlags,
  EmailAttachment,
} from './types.ts';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Gmail API types
interface GmailMessageHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: {
    size?: number;
    data?: string;
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
}

interface GmailMessageResponse {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: GmailMessageHeader[];
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
  internalDate?: string;
}

interface GmailListResponse {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/**
 * Decode base64url encoded content
 */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(base64 + padding, 'base64').toString('utf-8');
}

/**
 * Extract header value from Gmail message
 */
function getHeader(headers: GmailMessageHeader[] | undefined, name: string): string {
  if (!headers) return '';
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

/**
 * Parse email address string into EmailAddress object
 */
function parseEmailAddress(addressStr: string): EmailAddress {
  const match = addressStr.match(/(?:"?([^"]*)"?\s)?(?:<)?([^>]+@[^>]+)(?:>)?/);
  if (match) {
    return {
      name: match[1]?.trim(),
      address: match[2]?.trim() || addressStr,
    };
  }
  return { address: addressStr };
}

/**
 * Parse multiple email addresses
 */
function parseEmailAddresses(addressStr: string): EmailAddress[] {
  if (!addressStr) return [];
  // Split by comma, but handle quoted names
  const addresses: EmailAddress[] = [];
  const parts = addressStr.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) {
      addresses.push(parseEmailAddress(trimmed));
    }
  }
  return addresses;
}

/**
 * Extract body text from Gmail message parts
 */
function extractBody(parts: GmailMessagePart[] | undefined, mimeType: string): string {
  if (!parts) return '';

  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) {
      try {
        return decodeBase64Url(part.body.data);
      } catch {
        continue;
      }
    }
    if (part.parts) {
      const nested = extractBody(part.parts, mimeType);
      if (nested) return nested;
    }
  }
  return '';
}

/**
 * Extract attachments from Gmail message parts
 */
function extractAttachments(parts: GmailMessagePart[] | undefined): EmailAttachment[] {
  if (!parts) return [];

  const attachments: EmailAttachment[] = [];
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      attachments.push(...extractAttachments(part.parts));
    }
  }
  return attachments;
}

/**
 * Convert Gmail message to EmailMessage
 */
function gmailToEmailMessage(gmail: GmailMessageResponse): EmailMessage {
  const headers = gmail.payload?.headers || [];

  return {
    id: gmail.id,
    threadId: gmail.threadId,
    subject: getHeader(headers, 'Subject'),
    from: parseEmailAddress(getHeader(headers, 'From')),
    to: parseEmailAddresses(getHeader(headers, 'To')),
    cc: parseEmailAddresses(getHeader(headers, 'Cc')),
    date: new Date(parseInt(gmail.internalDate || '0', 10)),
    snippet: gmail.snippet || '',
    bodyText: extractBody(gmail.payload?.parts, 'text/plain') ||
              (gmail.payload?.body?.data ? decodeBase64Url(gmail.payload.body.data) : ''),
    bodyHtml: extractBody(gmail.payload?.parts, 'text/html'),
    labels: gmail.labelIds,
    flags: {
      isRead: !gmail.labelIds?.includes('UNREAD'),
      isStarred: gmail.labelIds?.includes('STARRED') || false,
      isDraft: gmail.labelIds?.includes('DRAFT') || false,
      isImportant: gmail.labelIds?.includes('IMPORTANT'),
      isSpam: gmail.labelIds?.includes('SPAM'),
      isTrash: gmail.labelIds?.includes('TRASH'),
    },
    attachments: extractAttachments(gmail.payload?.parts),
  };
}

/**
 * Load Google OAuth credentials
 */
async function loadCredentials(): Promise<{ client_id: string; client_secret: string }> {
  const { readFile } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const { join } = await import('path');

  const RELAY_DIR = join(process.env.HOME || '~', '.claude-relay');
  const CREDENTIALS_FILE = join(RELAY_DIR, 'google-credentials.json');

  if (!existsSync(CREDENTIALS_FILE)) {
    throw new Error(
      `Google credentials file not found: ${CREDENTIALS_FILE}\n` +
      `Download it from Google Cloud Console > APIs & Services > Credentials`
    );
  }

  const content = await readFile(CREDENTIALS_FILE, 'utf-8');
  const creds = JSON.parse(content);
  // Google credentials use 'web' object format
  return {
    client_id: creds.web?.client_id || creds.client_id,
    client_secret: creds.web?.client_secret || creds.client_secret,
  };
}

/**
 * Google token refresh callback for TokenManager
 */
async function refreshGoogleToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const { client_id, client_secret } = await loadCredentials();

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id,
      client_secret,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token refresh failed: ${error}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    // Google doesn't always return a new refresh token
    refreshToken: data.refresh_token || undefined,
    expiresIn: data.expires_in,
  };
}

// Register refresh callback with TokenManager on first use
let refreshCallbackRegistered = false;

function ensureRefreshCallback(): void {
  if (!refreshCallbackRegistered) {
    getTokenManager().registerRefreshCallback('google', refreshGoogleToken);
    refreshCallbackRegistered = true;
  }
}

/**
 * Gmail Email Provider
 */
export class GmailProvider implements EmailProvider {
  private email: string;

  constructor(email: string) {
    this.email = email;
    ensureRefreshCallback();
  }

  /**
   * Get authorization header with valid access token
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const accessToken = await getTokenManager().getAccessToken('google', this.email);
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Make authenticated request to Gmail API
   */
  private async fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${GMAIL_API_BASE}${endpoint}`, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    // Log rate limit headers for observability
    const rateLimit = response.headers.get('x-ratelimit-limit');
    const rateRemaining = response.headers.get('x-ratelimit-remaining');
    if (rateLimit || rateRemaining) {
      console.log(`[Gmail API] Rate limit: ${rateRemaining}/${rateLimit} remaining`);
    }

    if (!response.ok) {
      const error = await response.text();
      // Token might be expired - invalidate and retry
      // TokenManager will handle getting a fresh token on next getAccessToken call
      if (response.status === 401) {
        await getTokenManager().invalidateToken('google', this.email, 'Gmail API 401 - token expired');
        const newHeaders = await this.getAuthHeaders();
        const retryResponse = await fetch(`${GMAIL_API_BASE}${endpoint}`, {
          ...options,
          headers: { ...newHeaders, ...options?.headers },
        });
        if (retryResponse.ok) {
          return retryResponse.json();
        }
      }
      throw new Error(`Gmail API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async getProviderInfo(): Promise<ProviderInfo> {
    const capabilities: ProviderCapabilities = {
      canSend: true,
      canSearch: true,
      canModifyLabels: true,
      canMoveToFolder: true,
      supportsThreads: true,
      supportsDrafts: true,
      maxAttachmentSize: 25 * 1024 * 1024, // 25MB
    };

    return {
      type: 'gmail',
      emailAddress: this.email,
      capabilities,
    };
  }

  async authenticate(): Promise<void> {
    // Verify by fetching profile - TokenManager handles token retrieval/refresh
    await this.fetchApi('/users/me/profile');
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      // Check if we can get a valid access token
      await getTokenManager().getAccessToken('google', this.email);
      return true;
    } catch {
      return false;
    }
  }

  async listMessages(options?: ListMessagesOptions): Promise<ListMessagesResult> {
    const params = new URLSearchParams();
    params.set('userId', 'me');

    if (options?.maxResults) {
      params.set('maxResults', String(options.maxResults));
    } else {
      params.set('maxResults', '20');
    }

    if (options?.pageToken) {
      params.set('pageToken', options.pageToken);
    }

    if (options?.labelIds?.length) {
      params.set('labelIds', options.labelIds.join(','));
    }

    if (options?.query) {
      params.set('q', options.query);
    }

    if (options?.includeSpamTrash) {
      params.set('includeSpamTrash', 'true');
    }

    // Get list of message IDs
    const listData: GmailListResponse = await this.fetchApi(
      `/users/me/messages?${params.toString()}`
    );

    if (!listData.messages?.length) {
      return { messages: [], nextPageToken: listData.nextPageToken };
    }

    // Fetch full message details (up to 10 at a time to avoid rate limits)
    const messageIds = listData.messages.slice(0, options?.maxResults || 20).map(m => m.id);
    const messages = await this.getMessages(messageIds);

    return {
      messages,
      nextPageToken: listData.nextPageToken,
      resultSizeEstimate: listData.resultSizeEstimate,
    };
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const data: GmailMessageResponse = await this.fetchApi(
      `/users/me/messages/${messageId}?format=full`
    );
    return gmailToEmailMessage(data);
  }

  async getMessages(messageIds: string[]): Promise<EmailMessage[]> {
    // Gmail doesn't have a batch get, so we fetch in parallel
    const promises = messageIds.map(id =>
      this.fetchApi<GmailMessageResponse>(`/users/me/messages/${id}?format=full`)
        .then(gmailToEmailMessage)
        .catch(err => {
          console.error(`Failed to fetch message ${id}:`, err.message);
          return null;
        })
    );

    const results = await Promise.all(promises);
    return results.filter((m): m is EmailMessage => m !== null);
  }

  async sendMessage(options: SendMessageOptions): Promise<{ id: string; threadId?: string }> {
    // Build RFC 2822 message
    const boundary = `boundary_${Date.now()}`;
    const lines: string[] = [];

    // Headers
    lines.push(`To: ${options.to.map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', ')}`);
    lines.push(`Subject: =?UTF-8?B?${Buffer.from(options.subject).toString('base64')}?=`);

    if (options.cc?.length) {
      lines.push(`Cc: ${options.cc.map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', ')}`);
    }

    if (options.bcc?.length) {
      lines.push(`Bcc: ${options.bcc.map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', ')}`);
    }

    if (options.replyTo) {
      lines.push(`Reply-To: ${options.replyTo}`);
    }

    if (options.threadId) {
      // For threading, we'd need the Message-ID of the original message
      // This is a simplified version
    }

    lines.push('MIME-Version: 1.0');

    const hasAttachments = options.attachments?.length;

    if (hasAttachments) {
      lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      lines.push('');
      lines.push(`--${boundary}`);

      // Text part
      if (options.bodyText) {
        lines.push('Content-Type: text/plain; charset=UTF-8');
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(Buffer.from(options.bodyText).toString('base64'));
        lines.push('');
      }

      // HTML part
      if (options.bodyHtml) {
        lines.push(`--${boundary}`);
        lines.push('Content-Type: text/html; charset=UTF-8');
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(Buffer.from(options.bodyHtml).toString('base64'));
        lines.push('');
      }

      // Attachments
      for (const att of options.attachments || []) {
        lines.push(`--${boundary}`);
        lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
        lines.push('');
        lines.push(att.content.toString('base64'));
        lines.push('');
      }

      lines.push(`--${boundary}--`);
    } else {
      // Simple text or HTML
      if (options.bodyHtml) {
        lines.push('Content-Type: text/html; charset=UTF-8');
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(Buffer.from(options.bodyHtml).toString('base64'));
      } else {
        lines.push('Content-Type: text/plain; charset=UTF-8');
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(Buffer.from(options.bodyText || '').toString('base64'));
      }
    }

    const rawMessage = lines.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await this.fetchApi<{ id: string; threadId: string }>(
      '/users/me/messages/send',
      {
        method: 'POST',
        body: JSON.stringify({ raw: encodedMessage, threadId: options.threadId }),
      }
    );

    return response;
  }

  async searchMessages(options: SearchMessagesOptions): Promise<ListMessagesResult> {
    // Build Gmail search query
    const queryParts: string[] = [options.query];

    if (options.from) {
      queryParts.push(`from:${options.from}`);
    }

    if (options.to) {
      queryParts.push(`to:${options.to}`);
    }

    if (options.dateFrom) {
      queryParts.push(`after:${options.dateFrom.toISOString().split('T')[0]}`);
    }

    if (options.dateTo) {
      queryParts.push(`before:${options.dateTo.toISOString().split('T')[0]}`);
    }

    if (options.hasAttachments) {
      queryParts.push('has:attachment');
    }

    return this.listMessages({
      query: queryParts.join(' '),
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.fetchApi(
      `/users/me/messages/${messageId}/modify`,
      {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      }
    );
  }

  async markAsUnread(messageId: string): Promise<void> {
    await this.fetchApi(
      `/users/me/messages/${messageId}/modify`,
      {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: ['UNREAD'] }),
      }
    );
  }

  async starMessage(messageId: string): Promise<void> {
    await this.fetchApi(
      `/users/me/messages/${messageId}/modify`,
      {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: ['STARRED'] }),
      }
    );
  }

  async unstarMessage(messageId: string): Promise<void> {
    await this.fetchApi(
      `/users/me/messages/${messageId}/modify`,
      {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: ['STARRED'] }),
      }
    );
  }

  async trashMessage(messageId: string): Promise<void> {
    await this.fetchApi(
      `/users/me/messages/${messageId}/trash`,
      { method: 'POST' }
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.fetchApi(
      `/users/me/messages/${messageId}`,
      { method: 'DELETE' }
    );
  }

  async getLabels(): Promise<{ id: string; name: string; type: string }[]> {
    const response = await this.fetchApi<{ labels: { id: string; name: string; type: string }[] }>(
      '/users/me/labels'
    );
    return response.labels || [];
  }
}

/**
 * Create a Gmail provider for a specific account
 */
export function createGmailProvider(email: string): GmailProvider {
  return new GmailProvider(email);
}
