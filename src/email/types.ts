/**
 * Email Provider Types
 *
 * Provider-agnostic interfaces for email operations.
 * Supports Gmail, Outlook, and generic IMAP providers.
 */

// Provider types
export type EmailProviderType = 'gmail' | 'outlook' | 'imap' | 'smtp';

// Email address structure
export interface EmailAddress {
  address: string;
  name?: string;
}

// Email message structure
export interface EmailMessage {
  id: string;
  threadId?: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  date: Date;
  snippet: string;
  bodyText?: string;
  bodyHtml?: string;
  labels?: string[];
  flags?: EmailFlags;
  attachments?: EmailAttachment[];
}

// Email flags
export interface EmailFlags {
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  isImportant?: boolean;
  isSpam?: boolean;
  isTrash?: boolean;
}

// Email attachment
export interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

// Message list options
export interface ListMessagesOptions {
  maxResults?: number;
  pageToken?: string;
  labelIds?: string[];
  query?: string;
  includeSpamTrash?: boolean;
}

// Message list result
export interface ListMessagesResult {
  messages: EmailMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

// Send message options
export interface SendMessageOptions {
  to: EmailAddress[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  attachments?: {
    filename: string;
    content: Buffer;
    mimeType: string;
  }[];
  replyTo?: string;
  threadId?: string;
}

// Search options
export interface SearchMessagesOptions {
  query: string;
  maxResults?: number;
  pageToken?: string;
  dateFrom?: Date;
  dateTo?: Date;
  from?: string;
  to?: string;
  hasAttachments?: boolean;
}

// Provider capabilities
export interface ProviderCapabilities {
  canSend: boolean;
  canSearch: boolean;
  canModifyLabels: boolean;
  canMoveToFolder: boolean;
  supportsThreads: boolean;
  supportsDrafts: boolean;
  maxAttachmentSize: number; // in bytes
}

// Provider info
export interface ProviderInfo {
  type: EmailProviderType;
  emailAddress: string;
  displayName?: string;
  capabilities: ProviderCapabilities;
}

/**
 * Email Provider Interface
 *
 * All email providers must implement this interface.
 */
export interface EmailProvider {
  /**
   * Get provider information and capabilities
   */
  getProviderInfo(): Promise<ProviderInfo>;

  /**
   * Authenticate and verify connection
   * @throws Error if authentication fails
   */
  authenticate(): Promise<void>;

  /**
   * Check if the provider is currently authenticated
   */
  isAuthenticated(): Promise<boolean>;

  /**
   * List messages from the inbox
   */
  listMessages(options?: ListMessagesOptions): Promise<ListMessagesResult>;

  /**
   * Get a single message by ID
   */
  getMessage(messageId: string): Promise<EmailMessage>;

  /**
   * Get multiple messages by ID
   */
  getMessages(messageIds: string[]): Promise<EmailMessage[]>;

  /**
   * Send a message
   */
  sendMessage(options: SendMessageOptions): Promise<{ id: string; threadId?: string }>;

  /**
   * Search messages
   */
  searchMessages(options: SearchMessagesOptions): Promise<ListMessagesResult>;

  /**
   * Mark a message as read
   */
  markAsRead(messageId: string): Promise<void>;

  /**
   * Mark a message as unread
   */
  markAsUnread(messageId: string): Promise<void>;

  /**
   * Star/flag a message
   */
  starMessage(messageId: string): Promise<void>;

  /**
   * Unstar/unflag a message
   */
  unstarMessage(messageId: string): Promise<void>;

  /**
   * Move message to trash
   */
  trashMessage(messageId: string): Promise<void>;

  /**
   * Permanently delete a message
   */
  deleteMessage(messageId: string): Promise<void>;

  /**
   * Get labels/folders for the account
   */
  getLabels(): Promise<{ id: string; name: string; type: string }[]>;
}

/**
 * Email Account Configuration
 */
export interface EmailAccountConfig {
  id: string;
  providerType: EmailProviderType;
  emailAddress: string;
  displayName?: string;
  isActive: boolean;
  syncEnabled: boolean;
  credentials?: Record<string, unknown>;
}
