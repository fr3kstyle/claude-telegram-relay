# Google OAuth Setup Guide

Complete setup for Gmail, Calendar, and Drive API access.

## Prerequisites

- Google account(s) to authorize
- Access to [Google Cloud Console](https://console.cloud.google.com/)

---

## Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **"Select a project"** at top → **"NEW PROJECT"**
3. Project name: `Claude Agent`
4. Click **CREATE**
5. Select your new project

---

## Step 2: Enable APIs

Go to **APIs & Services** → **Library**, search and **ENABLE** each:

| API | Purpose |
|-----|---------|
| Gmail API | Read/send emails |
| Google Calendar API | Manage events |
| Google Drive API | Access files |

---

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. User type: **External** → Click **CREATE**

Fill in required fields:

| Field | Value |
|-------|-------|
| App name | `Claude Agent` |
| User support email | *(select your email)* |
| Developer contact email | *(your email)* |

Click **SAVE AND CONTINUE**

---

## Step 4: Add Scopes

1. Click **ADD OR REMOVE SCOPES**
2. Add these scopes (use the filter to find them):

```
Gmail:
✓ .../auth/gmail.readonly
✓ .../auth/gmail.send
✓ .../auth/gmail.modify

Calendar:
✓ .../auth/calendar
✓ .../auth/calendar.events

Drive:
✓ .../auth/drive
```

3. Click **UPDATE** → **SAVE AND CONTINUE**

---

## Step 5: Add Test Users

Since this is "External" mode, you need to add yourself as a test user:

1. Click **ADD USERS**
2. Add both emails:
   - `Fr3kchy@gmail.com`
   - `fr3k@mcpintelligence.com.au`
3. Click **ADD** → **SAVE AND CONTINUE**

---

## Step 6: Create OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **CREATE CREDENTIALS** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `Claude Agent Client`
5. Under "Authorized redirect URIs", click **ADD URI**:
   ```
   http://localhost:8080/oauth/callback
   ```
6. Click **CREATE**
7. **Important**: Click the **Download** icon (↓) to download the JSON file

---

## Step 7: Save Credentials

Move the downloaded JSON file:

```bash
# Replace ~/Downloads/client_secret_XXX.json with your actual download path
mv ~/Downloads/client_secret_*.json ~/.claude-relay/google-credentials.json
```

---

## Step 8: Run OAuth Setup

```bash
cd /home/radxa/claude-telegram-relay
bun run src/google-oauth.ts
```

Follow the prompts for each account:

1. Click the URL (or copy to browser)
2. Log in with that specific Google account
3. Click **Continue** on warning screens (unverified app is normal)
4. Check all permissions and click **Allow**
5. You'll be redirected to localhost (page won't load - that's OK!)
6. Copy the `code` parameter from the URL in your browser address bar
   - Example: `http://localhost:8080/oauth/callback?code=4/0AX...&scope=...`
   - Copy just the `4/0AX...` part
7. Paste the code in terminal

Repeat for both accounts.

---

## Step 9: Verify Setup

```bash
# Test with bun
bun -e '
import { getAuthorizedAccounts } from "./src/google-apis.ts";
const accounts = await getAuthorizedAccounts();
console.log("Authorized accounts:", accounts);
'
```

---

## Usage in Your Agent

Once set up, your agent can use these APIs:

### Gmail

```typescript
import { listEmails, sendEmail, searchEmails } from "./src/google-apis.ts";

// List recent emails
const emails = await listEmails("Fr3kchy@gmail.com", { maxResults: 5 });

// Search emails
const results = await searchEmails("Fr3kchy@gmail.com", "from:boss@work.com");

// Send email
await sendEmail("Fr3kchy@gmail.com", {
  to: "someone@example.com",
  subject: "Hello",
  body: "This is the email body",
});
```

### Calendar

```typescript
import { listEvents, createEvent, searchEvents } from "./src/google-apis.ts";

// List upcoming events
const events = await listEvents("Fr3kchy@gmail.com", { maxResults: 10 });

// Create event
await createEvent("Fr3kchy@gmail.com", {
  summary: "Meeting with client",
  start: { dateTime: "2026-02-17T10:00:00", timeZone: "Australia/Brisbane" },
  end: { dateTime: "2026-02-17T11:00:00", timeZone: "Australia/Brisbane" },
  description: "Discuss project timeline",
});
```

### Drive

```typescript
import { listFiles, searchFiles, downloadFile, createFile } from "./src/google-apis.ts";

// List recent files
const files = await listFiles("Fr3kchy@gmail.com");

// Search files
const docs = await searchFiles("Fr3kchy@gmail.com", "project proposal");

// Download file
const { content, name } = await downloadFile("Fr3kchy@gmail.com", fileId);

// Create file
await createFile("Fr3kchy@gmail.com", {
  name: "notes.txt",
  content: "My notes here",
});
```

---

## Token Storage

Tokens are stored in: `~/.claude-relay/google-tokens/`

- One JSON file per account
- Contains refresh token (long-lived)
- Access tokens auto-refresh when expired

---

## Security Notes

1. **Never commit** `google-credentials.json` to git
2. The credentials file contains your client secret
3. Tokens are account-specific and should be protected
4. You can revoke access anytime at: https://myaccount.google.com/permissions

---

## Troubleshooting

### "Credentials file not found"
- Make sure you downloaded and renamed the JSON file
- Check path: `~/.claude-relay/google-credentials.json`

### "Token exchange failed"
- Code might be expired (they're single-use)
- Run setup again and get a fresh code

### "Access blocked: App is waiting for verification"
- This is normal for unverified apps
- Click "Advanced" → "Go to Claude Agent (unsafe)"

### "Invalid scope"
- Make sure you added all required scopes in Step 4
- Re-download credentials if needed

---

## Files Created

| File | Purpose |
|------|---------|
| `src/google-oauth.ts` | OAuth authentication flow |
| `src/google-apis.ts` | Gmail, Calendar, Drive API wrappers |
| `~/.claude-relay/google-credentials.json` | OAuth client credentials |
| `~/.claude-relay/google-tokens/*.json` | Per-account tokens |
