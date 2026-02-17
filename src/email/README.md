# Email Module - Provider Abstraction Pattern

This module provides a provider-agnostic email interface that supports Gmail, Outlook, and can be extended to other providers (IMAP, SMTP).

## Architecture

```
index.ts (public API)
    |
    v
provider-factory.ts (singleton factory)
    |
    +-- gmail-provider.ts (implements EmailProvider)
    +-- outlook-provider.ts (implements EmailProvider)
    |
    v
types.ts (interfaces: EmailProvider, EmailMessage, etc.)
```

## Key Interfaces

### EmailProvider (types.ts:122)

All providers must implement this interface:

```typescript
interface EmailProvider {
  getProviderInfo(): Promise<ProviderInfo>;
  authenticate(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  listMessages(options?: ListMessagesOptions): Promise<ListMessagesResult>;
  getMessage(messageId: string): Promise<EmailMessage>;
  getMessages(messageIds: string[]): Promise<EmailMessage[]>;
  sendMessage(options: SendMessageOptions): Promise<{ id: string; threadId?: string }>;
  searchMessages(options: SearchMessagesOptions): Promise<ListMessagesResult>;
  markAsRead(messageId: string): Promise<void>;
  markAsUnread(messageId: string): Promise<void>;
  starMessage(messageId: string): Promise<void>;
  unstarMessage(messageId: string): Promise<void>;
  trashMessage(messageId: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  getLabels(): Promise<{ id: string; name: string; type: string }[]>;
}
```

### EmailProviderFactory (provider-factory.ts)

Singleton factory that:
1. Registers providers with capabilities metadata
2. Creates provider instances on demand
3. Discovers accounts from database or token files
4. Caches instances per email address

## Adding a New Provider

### Step 1: Create the Provider Class

Create `src/email/newprovider-provider.ts`:

```typescript
import type {
  EmailProvider,
  EmailMessage,
  ListMessagesOptions,
  ListMessagesResult,
  SendMessageOptions,
  SearchMessagesOptions,
  ProviderInfo,
  ProviderCapabilities,
} from './types.ts';

const CAPABILITIES: ProviderCapabilities = {
  canSend: true,
  canSearch: true,
  canModifyLabels: false, // adjust per provider
  canMoveToFolder: true,
  supportsThreads: false, // adjust per provider
  supportsDrafts: false, // adjust per provider
  maxAttachmentSize: 10 * 1024 * 1024, // 10MB example
};

export class NewProvider implements EmailProvider {
  constructor(private email: string) {}

  async getProviderInfo(): Promise<ProviderInfo> {
    return {
      type: 'newprovider',
      emailAddress: this.email,
      capabilities: CAPABILITIES,
    };
  }

  async authenticate(): Promise<void> {
    // Implement OAuth or other auth flow
  }

  async isAuthenticated(): Promise<boolean> {
    // Check if tokens are valid
    return false;
  }

  // Implement all other interface methods...
}

export function createNewProvider(email: string): NewProvider {
  return new NewProvider(email);
}
```

### Step 2: Register in Factory

Edit `provider-factory.ts`:

```typescript
import { NewProvider, createNewProvider } from './newprovider-provider.ts';

// In constructor:
private registerNewProvider(): void {
  this.register({
    type: 'newprovider',
    factory: createNewProvider,
    capabilities: CAPABILITIES,
  });
}

constructor() {
  this.registerGmailProvider();
  this.registerOutlookProvider();
  this.registerNewProvider(); // Add this
}
```

### Step 3: Export from Index

Edit `index.ts`:

```typescript
export { NewProvider, createNewProvider } from './newprovider-provider.ts';
```

### Step 4: Add OAuth Module (if needed)

Create `src/newprovider-oauth.ts` following the pattern in `google-oauth.ts` or `microsoft-oauth.ts`:
- Token storage via TokenManager
- Authorization URL generation
- Token refresh logic
- Scope definitions

## Normalized Data Flow

1. Provider API returns provider-specific format
2. Provider class converts to `EmailMessage` interface
3. `emailMessageToRelayFormat()` converts to `RelayEmailMessage` for backward compatibility
4. relay.ts uses the relay format

This normalization means relay.ts doesn't need to know which provider is being used.

## Error Handling

Each provider includes:
- Circuit breaker for API failures (5 failures → 60s cooldown)
- Graceful fallback when database unavailable
- Rate limit logging for observability

## Token Management

Use `auth/token-manager.ts` for OAuth token storage:
- Primary: Supabase `oauth_tokens` table
- Fallback: File-based storage when database unavailable
- Automatic token refresh when expired
