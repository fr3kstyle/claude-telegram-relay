# Azure Portal Credentials Setup Guide

This guide walks through extracting Microsoft OAuth credentials from the Azure Portal for the Claude Telegram Relay's Outlook/Office 365 integration.

## Prerequisites

- Microsoft account (personal or work/school)
- Access to [Azure Portal](https://portal.azure.com)

## Step-by-Step Instructions

### 1. Navigate to App Registrations

1. Go to [Azure Portal](https://portal.azure.com)
2. Sign in with your Microsoft account
3. Search for "App registrations" in the search bar
4. Click **App registrations** from the results

   Or go directly: https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade

### 2. Register a New Application (or use existing)

**If creating new:**
1. Click **New registration**
2. Enter a name (e.g., "Claude Telegram Relay")
3. For "Supported account types", choose:
   - **Personal Microsoft accounts only** - if using personal Outlook.com
   - **Accounts in any organizational directory and personal Microsoft accounts** - for both work and personal
4. For "Redirect URI":
   - Select **Web** from the dropdown
   - Enter: `http://localhost`
   - (This is a placeholder - the OAuth flow uses device code or manual URL visit)
5. Click **Register**

### 3. Get the Application (Client) ID

1. In your app's overview page, find **Application (client) ID**
2. This is your `client_id` - copy it

### 4. Create a Client Secret

1. In the left sidebar, click **Certificates & secrets**
2. Click **New client secret**
3. Enter a description (e.g., "Relay secret")
4. Choose an expiry (24 months recommended)
5. Click **Add**
6. **IMPORTANT**: Copy the **Value** immediately (not the Secret ID)
   - You won't be able to see it again!
   - This is your `client_secret`

### 5. Configure API Permissions

1. In the left sidebar, click **API permissions**
2. Click **Add a permission**
3. Select **Microsoft Graph**
4. Choose **Delegated permissions**
5. Search and add these permissions:
   - `Mail.Read` - Read mail
   - `Mail.ReadWrite` - Read and write mail
   - `Mail.Send` - Send mail
   - `Calendars.Read` - Read calendars
   - `Calendars.ReadWrite` - Read and write calendars
   - `Files.Read` - Read files (OneDrive)
   - `Files.ReadWrite` - Read and write files
   - `User.Read` - Sign in and read user profile
   - `offline_access` - Maintain access (refresh tokens)
6. Click **Add permissions**

### 6. Create the Credentials File

Create the file at `~/.claude-relay/microsoft-credentials.json`:

```json
{
  "client_id": "YOUR_APPLICATION_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET_VALUE",
  "redirect_uris": ["http://localhost"]
}
```

Replace:
- `YOUR_APPLICATION_CLIENT_ID` with the Application (client) ID from Step 3
- `YOUR_CLIENT_SECRET_VALUE` with the secret value from Step 4

### 7. Verify Setup

Run the OAuth setup:

```bash
bun run src/microsoft-oauth.ts setup
```

This will:
1. Verify the credentials file exists
2. Display an authorization URL
3. Guide you through the consent flow

## Quick Reference

| Credential | Azure Portal Location | JSON Field |
|------------|----------------------|------------|
| Application ID | Overview > Application (client) ID | `client_id` |
| Client Secret | Certificates & secrets > Value (not ID) | `client_secret` |
| Redirect URI | Authentication > Web platform | `redirect_uris[0]` |

## Troubleshooting

### "AADSTS700016: Application not found"
- Verify the `client_id` matches exactly (no extra spaces)
- Ensure the app exists in the same tenant you're logging into

### "AADSTS7000218: Client secret expired"
- Go back to Certificates & secrets
- Create a new secret
- Update the credentials file

### "AADSTS65001: The user or administrator has not consented"
- Visit the authorization URL manually
- Complete the consent flow
- Some organizations require admin consent for certain permissions

### "Insufficient privileges"
- Some permissions require admin consent in organizational tenants
- Try with fewer permissions or contact your IT admin

## Security Notes

- **Never commit** `microsoft-credentials.json` to version control
- The file is already in `.gitignore`
- Client secrets expire - set a calendar reminder
- If a secret is compromised, delete it in Azure Portal immediately

## Related Files

- `src/microsoft-oauth.ts` - OAuth handler
- `src/email/outlook-provider.ts` - Outlook email provider
- `~/.claude-relay/microsoft-tokens/` - Stored tokens per account
