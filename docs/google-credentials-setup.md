# Google Cloud Console Credentials Setup Guide

This guide walks through extracting Google OAuth credentials from the Google Cloud Console for the Claude Telegram Relay's Gmail, Calendar, and Drive integration.

## Prerequisites

- Google account (personal or Google Workspace)
- Access to [Google Cloud Console](https://console.cloud.google.com)

## Step-by-Step Instructions

### 1. Create or Select a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Sign in with your Google account
3. Click the project dropdown at the top and select **New Project** (or use an existing one)
4. Name it (e.g., "Claude Telegram Relay")
5. Click **Create**

### 2. Configure OAuth Consent Screen

1. In the left sidebar, go to **APIs & Services** → **OAuth consent screen**
2. Choose user type:
   - **External** - for personal Gmail accounts (recommended)
   - **Internal** - only for Google Workspace organizations
3. Click **Create**
4. Fill in required fields:
   - App name: "Claude Telegram Relay"
   - User support email: your email
   - Developer contact: your email
5. Click **Save and Continue**

### 3. Add OAuth Scopes

On the Scopes page:

1. Click **Add or Remove Scopes**
2. Search for and add these scopes:

   | Scope | Purpose |
   |-------|---------|
   | `https://www.googleapis.com/auth/gmail.readonly` | Read emails |
   | `https://www.googleapis.com/auth/gmail.send` | Send emails |
   | `https://www.googleapis.com/auth/gmail.modify` | Modify emails (labels, mark read) |
   | `https://www.googleapis.com/auth/calendar` | Full calendar access |
   | `https://www.googleapis.com/auth/calendar.events` | Manage calendar events |
   | `https://www.googleapis.com/auth/drive` | Full Drive access |

3. Click **Update** then **Save and Continue**

### 4. Add Test Users (for External apps in testing)

If your app is in "Testing" mode:

1. Click **Add Users**
2. Enter your Gmail address
3. Click **Save and Continue**

> **Note:** While in testing, only added users can authorize the app. For production use, publish the app.

### 5. Create OAuth 2.0 Credentials

1. In the left sidebar, go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: "Claude Relay"
5. Under "Authorized redirect URIs", add: `http://localhost`
6. Click **Create**
7. **IMPORTANT**: Copy both the **Client ID** and **Client Secret**

### 6. Create the Credentials File

Create the file at `~/.claude-relay/google-credentials.json`:

```json
{
  "web": {
    "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "client_secret": "YOUR_CLIENT_SECRET",
    "redirect_uris": ["http://localhost"]
  }
}
```

**Schema Reference:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `web.client_id` | string | Yes | OAuth 2.0 Client ID from Credentials page |
| `web.client_secret` | string | Yes | OAuth 2.0 Client Secret from Credentials page |
| `web.redirect_uris` | string[] | Yes | Array of redirect URIs; first entry is used |

**Example with real-ish values:**

```json
{
  "web": {
    "client_id": "123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com",
    "client_secret": "GOCSPX-abcdefghijABCDEFGHIJ1234567890",
    "redirect_uris": ["http://localhost"]
  }
}
```

> **TypeScript Interface:** The `Credentials` interface in `src/google-oauth.ts` defines the schema:
> ```typescript
> interface Credentials {
>   web: {
>     client_id: string;
>     client_secret: string;
>     redirect_uris: string[];
>   };
> }
> ```

### 7. Verify Setup

Run the OAuth setup:

```bash
bun run src/google-oauth.ts setup
```

This will:
1. Verify the credentials file exists
2. Display an authorization URL
3. Guide you through the consent flow
4. Save tokens to `~/.claude-relay/google-tokens/`

## Required Scopes Summary

| Scope | Functionality | Required |
|-------|--------------|----------|
| `gmail.readonly` | Read inbox, view messages | Yes |
| `gmail.send` | Send emails | Yes |
| `gmail.modify` | Add labels, mark as read | No |
| `calendar` | View calendars | No |
| `calendar.events` | Create/edit events | No |
| `drive` | Access Drive files | No |

The relay will warn you if critical scopes (`gmail.readonly`, `gmail.send`) are missing during authorization.

## Quick Reference

| Credential | Google Cloud Location | JSON Field |
|------------|----------------------|------------|
| Client ID | Credentials → OAuth 2.0 Client IDs | `web.client_id` |
| Client Secret | Credentials → OAuth 2.0 Client IDs | `web.client_secret` |
| Redirect URI | Credentials → OAuth client → Authorized redirect URIs | `web.redirect_uris[0]` |
| Scopes | OAuth consent screen → Scopes | (configured in console) |

## Troubleshooting

### "access_denied" during authorization
- Ensure your email is added as a test user (for apps in Testing mode)
- Check that all required scopes are configured

### "invalid_client" error
- Verify `client_id` is copied exactly (no extra spaces)
- Ensure the OAuth client wasn't deleted

### "redirect_uri_mismatch" error
- Add `http://localhost` to authorized redirect URIs
- Wait a few minutes for changes to propagate

### "insufficient permissions" when using email features
- Re-authorize to grant missing scopes
- Check the token file's `scope_warnings` field for missing scopes

### Gmail API not enabled
1. Go to **APIs & Services** → **Library**
2. Search for "Gmail API"
3. Click **Enable**
4. Repeat for "Calendar API" and "Drive API" if needed

## Security Notes

- **Never commit** `google-credentials.json` to version control
- The file is already in `.gitignore`
- Client secrets can be regenerated if compromised
- Tokens are stored locally in `~/.claude-relay/google-tokens/`
- Refresh tokens may expire if not used for 6 months (Google policy)

## Consent Flow

The OAuth consent flow works as follows:

1. **Run setup command**: `bun run src/google-oauth.ts setup`
2. **Visit URL**: Console prints a Google authorization URL
3. **Sign in**: Authenticate with your Google account
4. **Grant permissions**: Review and allow the requested scopes
5. **Copy code**: Google redirects to localhost with a `code` parameter
6. **Paste code**: Enter the code in the terminal
7. **Token saved**: Access and refresh tokens are saved locally

For multiple accounts, run the setup command again with a different email.

## Related Files

- `src/google-oauth.ts` - OAuth handler
- `src/email/gmail-provider.ts` - Gmail email provider
- `~/.claude-relay/google-tokens/` - Stored tokens per account
