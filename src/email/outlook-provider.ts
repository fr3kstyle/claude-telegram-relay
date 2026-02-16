/**
 * Outlook Provider Implementation
 *
 * Implements EmailProvider interface using Microsoft Graph API.
 * Uses OAuth tokens from microsoft-oauth.ts module.
 */

import { getValidAccessToken } from '../microsoft-oauth.ts';
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

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

// Microsoft Graph API types
interface GraphMessageRecipient {
  emailAddress: {
    address: string;
    name?: string;
  };
}

interface GraphMessageBody {
  contentType: 'text' | 'html';
  content: string;
}

interface GraphMessageResponse {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GraphMessageRecipient;
  toRecipients?: GraphMessageRecipient[];
  ccRecipients?: GraphMessageRecipient[];
  bccRecipients?: GraphMessageRecipient[];
  receivedDateTime: string;
  bodyPreview?: string;
  body?: GraphMessageBody;
  isRead?: boolean;
  isDraft?: boolean;
  importance?: 'low' | 'normal' | 'high';
  flag?: { flagStatus: string };
  hasAttachments?: boolean;
  internetMessageId?: string;
  parentFolderId?: string;
}

interface GraphListResponse {
  value: GraphMessageResponse[];
  '@odata.nextLink'?: string;
}

interface GraphFolder {
  id: string;
  displayName: string;
  wellKnownName?: string;
}

/**
 * Parse Graph recipient to EmailAddress
 */
function parseRecipient(recipient: GraphMessageRecipient | undefined): EmailAddress {
  if (!recipient?.emailAddress) {
    return { address: '' };
  }
  return {
    address: recipient.emailAddress.address,
    name: recipient.emailAddress.name,
  };
}

/**
 * Parse multiple Graph recipients
 */
function parseRecipients(recipients: GraphMessageRecipient[] | undefined): EmailAddress[] {
  if (!recipients) return [];
  return recipients.map(parseRecipient).filter(a => a.address);
}

/**
 * Convert Graph message to EmailMessage
 */
function graphToEmailMessage(graph: GraphMessageResponse): EmailMessage {
  const flags: EmailFlags = {
    isRead: graph.isRead ?? true,
    isStarred: graph.flag?.flagStatus === 'flagged',
    isDraft: graph.isDraft ?? false,
    isImportant: graph.importance === 'high',
  };

  return {
    id: graph.id,
    threadId: graph.conversationId,
    subject: graph.subject || '(no subject)',
    from: parseRecipient(graph.from),
    to: parseRecipients(graph.toRecipients),
    cc: parseRecipients(graph.ccRecipients),
    date: new Date(graph.receivedDateTime),
    snippet: graph.bodyPreview || '',
    bodyText: graph.body?.contentType === 'text' ? graph.body.content : undefined,
    bodyHtml: graph.body?.contentType === 'html' ? graph.body.content : undefined,
    labels: graph.parentFolderId ? [graph.parentFolderId] : undefined,
    flags,
    attachments: [], // Will be fetched separately if needed
  };
}

/**
 * Outlook Email Provider
 */
export class OutlookProvider implements EmailProvider {
  private email: string;
  private accessToken: string | null = null;

  constructor(email: string) {
    this.email = email;
  }

  /**
   * Get authorization header with valid access token
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (!this.accessToken) {
      this.accessToken = await getValidAccessToken(this.email);
    }
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Make authenticated request to Microsoft Graph API
   */
  private async fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${GRAPH_API_BASE}${endpoint}`, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    if (!response.ok) {
      const error = await response.text();
      // Token might be expired, try to refresh
      if (response.status === 401) {
        this.accessToken = null;
        const newHeaders = await this.getAuthHeaders();
        const retryResponse = await fetch(`${GRAPH_API_BASE}${endpoint}`, {
          ...options,
          headers: { ...newHeaders, ...options?.headers },
        });
        if (retryResponse.ok) {
          return retryResponse.json();
        }
        const retryError = await retryResponse.text();
        throw new Error(`Graph API error after retry: ${retryResponse.status} - ${retryError}`);
      }
      throw new Error(`Graph API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async getProviderInfo(): Promise<ProviderInfo> {
    const capabilities: ProviderCapabilities = {
      canSend: true,
      canSearch: true,
      canModifyLabels: false, // Outlook uses folders, not labels
      canMoveToFolder: true,
      supportsThreads: true, // Via conversationId
      supportsDrafts: true,
      maxAttachmentSize: 25 * 1024 * 1024, // 25MB for most accounts
    };

    return {
      type: 'outlook',
      emailAddress: this.email,
      capabilities,
    };
  }

  async authenticate(): Promise<void> {
    this.accessToken = await getValidAccessToken(this.email);
    // Verify by fetching user profile
    await this.fetchApi('/me');
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch {
      return false;
    }
  }

  async listMessages(options?: ListMessagesOptions): Promise<ListMessagesResult> {
    const params = new URLSearchParams();
    params.set('$top', String(options?.maxResults || 20));

    // Order by receivedDateTime descending
    params.set('$orderby', 'receivedDateTime desc');

    // Select specific fields to reduce payload
    params.set('$select', 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,isDraft,importance,flag,hasAttachments');

    if (options?.pageToken) {
      // For pagination, use skip token or nextLink
      params.set('$skip', options.pageToken);
    }

    // Handle folder filtering
    let endpoint = '/me/messages';
    if (options?.labelIds?.length) {
      // Map label to folder - for now use the first one as folder ID
      endpoint = `/me/mailFolders/${options.labelIds[0]}/messages`;
    }

    // Handle query search
    if (options?.query) {
      params.set('$search', `"${options.query}"`);
    }

    const data: GraphListResponse = await this.fetchApi(
      `${endpoint}?${params.toString()}`
    );

    const messages = data.value.map(graphToEmailMessage);

    // Extract skip token from nextLink if present
    let nextPageToken: string | undefined;
    if (data['@odata.nextLink']) {
      const nextUrl = new URL(data['@odata.nextLink']);
      nextPageToken = nextUrl.searchParams.get('$skip') || undefined;
    }

    return {
      messages,
      nextPageToken,
    };
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const data: GraphMessageResponse = await this.fetchApi(
      `/me/messages/${messageId}?$select=id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,body,isRead,isDraft,importance,flag,hasAttachments,internetMessageId,parentFolderId`
    );
    return graphToEmailMessage(data);
  }

  async getMessages(messageIds: string[]): Promise<EmailMessage[]> {
    // Microsoft Graph doesn't have a batch get for messages in the simple API
    // We'll fetch in parallel
    const promises = messageIds.map(id =>
      this.getMessage(id).catch(err => {
        console.error(`Failed to fetch message ${id}:`, err.message);
        return null;
      })
    );

    const results = await Promise.all(promises);
    return results.filter((m): m is EmailMessage => m !== null);
  }

  async sendMessage(options: SendMessageOptions): Promise<{ id: string; threadId?: string }> {
    // Build the message object for Graph API
    const message: Record<string, unknown> = {
      subject: options.subject,
      body: {
        contentType: options.bodyHtml ? 'html' : 'text',
        content: options.bodyHtml || options.bodyText || '',
      },
      toRecipients: options.to.map(a => ({
        emailAddress: { address: a.address, name: a.name },
      })),
    };

    if (options.cc?.length) {
      message.ccRecipients = options.cc.map(a => ({
        emailAddress: { address: a.address, name: a.name },
      }));
    }

    if (options.bcc?.length) {
      message.bccRecipients = options.bcc.map(a => ({
        emailAddress: { address: a.address, name: a.name },
      }));
    }

    // Handle reply threading
    if (options.threadId && options.replyTo) {
      // For replies, we need to use the /messages/{id}/reply endpoint
      const replyData = {
        message: {
          subject: options.subject,
          body: message.body,
        },
        comment: options.bodyText || options.bodyHtml || '',
      };

      await this.fetchApi(`/me/messages/${options.replyTo}/reply`, {
        method: 'POST',
        body: JSON.stringify(replyData),
      });

      // Graph API reply doesn't return the new message ID directly
      // We'd need to query sent items to get it
      return { id: '', threadId: options.threadId };
    }

    // Handle attachments
    if (options.attachments?.length) {
      // For attachments, we need to create a draft first, add attachments, then send
      const draft = await this.fetchApi<{ id: string }>(`/me/messages`, {
        method: 'POST',
        body: JSON.stringify({
          ...message,
          isDraft: true,
        }),
      });

      // Add attachments
      for (const att of options.attachments) {
        await this.fetchApi(`/me/messages/${draft.id}/attachments`, {
          method: 'POST',
          body: JSON.stringify({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.filename,
            contentType: att.mimeType,
            contentBytes: att.content.toString('base64'),
          }),
        });
      }

      // Send the draft
      await this.fetchApi(`/me/messages/${draft.id}/send`, {
        method: 'POST',
      });

      return { id: draft.id };
    }

    // Simple send without attachments
    const response = await this.fetchApi<{ id: string }>(`/me/sendMail`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        saveToSentItems: true,
      }),
    });

    return { id: response.id };
  }

  async searchMessages(options: SearchMessagesOptions): Promise<ListMessagesResult> {
    // Build Graph search query using $filter and $search
    const filterParts: string[] = [];

    if (options.from) {
      filterParts.push(`from/emailAddress/address eq '${options.from}'`);
    }

    if (options.to) {
      filterParts.push(`toRecipients/any(r:r/emailAddress/address eq '${options.to}')`);
    }

    if (options.hasAttachments) {
      filterParts.push('hasAttachments eq true');
    }

    const params: Record<string, string> = {
      '$top': String(options.maxResults || 20),
      '$orderby': 'receivedDateTime desc',
      '$select': 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,isDraft,importance,flag,hasAttachments',
    };

    // Use $search for full-text search (requires workload indexing)
    if (options.query) {
      params['$search'] = `"${options.query}"`;
    }

    // Use $filter for structured queries
    if (filterParts.length > 0) {
      params['$filter'] = filterParts.join(' and ');
    }

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const data: GraphListResponse = await this.fetchApi(
      `/me/messages?${queryString}`
    );

    const messages = data.value.map(graphToEmailMessage);

    let nextPageToken: string | undefined;
    if (data['@odata.nextLink']) {
      const nextUrl = new URL(data['@odata.nextLink']);
      nextPageToken = nextUrl.searchParams.get('$skip') || undefined;
    }

    return { messages, nextPageToken };
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.fetchApi(`/me/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isRead: true }),
    });
  }

  async markAsUnread(messageId: string): Promise<void> {
    await this.fetchApi(`/me/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isRead: false }),
    });
  }

  async starMessage(messageId: string): Promise<void> {
    await this.fetchApi(`/me/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ flag: { flagStatus: 'flagged' } }),
    });
  }

  async unstarMessage(messageId: string): Promise<void> {
    await this.fetchApi(`/me/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ flag: { flagStatus: 'notFlagged' } }),
    });
  }

  async trashMessage(messageId: string): Promise<void> {
    // Move to Deleted Items folder
    await this.fetchApi(`/me/messages/${messageId}/move`, {
      method: 'POST',
      body: JSON.stringify({ destinationId: 'deleteditems' }),
    });
  }

  async deleteMessage(messageId: string): Promise<void> {
    // Permanently delete
    await this.fetchApi(`/me/messages/${messageId}`, {
      method: 'DELETE',
    });
  }

  async getLabels(): Promise<{ id: string; name: string; type: string }[]> {
    // Outlook uses folders instead of labels
    const data = await this.fetchApi<{ value: GraphFolder[] }>('/me/mailFolders');
    return data.value.map(folder => ({
      id: folder.id,
      name: folder.displayName,
      type: folder.wellKnownName || 'user',
    }));
  }
}

/**
 * Create an Outlook provider for a specific account
 */
export function createOutlookProvider(email: string): OutlookProvider {
  return new OutlookProvider(email);
}
