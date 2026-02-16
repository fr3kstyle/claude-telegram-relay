/**
 * Microsoft OAuth 2.0 Handler
 *
 * Handles authentication for Outlook, OneDrive, and Microsoft Graph APIs.
 * Supports multiple Microsoft accounts (personal and work/school).
 *
 * Usage:
 * 1. Run: bun run src/microsoft-oauth.ts
 * 2. Visit the printed URL for each account
 * 3. Authorize and copy the code
 * 4. Tokens are saved to ~/.claude-relay/microsoft-tokens/
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const TOKENS_DIR = join(RELAY_DIR, "microsoft-tokens");
const CREDENTIALS_FILE = join(RELAY_DIR, "microsoft-credentials.json");

// Microsoft OAuth endpoints
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

// Required scopes for Mail, Calendar, and OneDrive
const SCOPES = [
  // Mail
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  // Calendar
  "https://graph.microsoft.com/Calendars.Read",
  "https://graph.microsoft.com/Calendars.ReadWrite",
  // OneDrive
  "https://graph.microsoft.com/Files.Read",
  "https://graph.microsoft.com/Files.ReadWrite",
  // User info
  "https://graph.microsoft.com/User.Read",
  // Offline access for refresh tokens
  "offline_access",
];

interface Credentials {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  email: string;
  account_type?: "personal" | "organizational";
}

/**
 * Load credentials from the JSON file downloaded from Azure Portal
 */
async function loadCredentials(): Promise<Credentials> {
  if (!existsSync(CREDENTIALS_FILE)) {
    throw new Error(
      `Credentials file not found: ${CREDENTIALS_FILE}\n` +
      `Download it from Azure Portal > App registrations > Your app > Certificates & secrets\n` +
      `Save as: ${CREDENTIALS_FILE}\n` +
      `Format: { "client_id": "...", "client_secret": "...", "redirect_uris": ["..."] }`
    );
  }

  const content = await readFile(CREDENTIALS_FILE, "utf-8");
  return JSON.parse(content);
}

/**
 * Save token for a specific account
 */
async function saveToken(email: string, tokenData: TokenData): Promise<void> {
  await mkdir(TOKENS_DIR, { recursive: true });

  // Sanitize email for filename
  const safeEmail = email.replace(/[@.]/g, "_");
  const tokenFile = join(TOKENS_DIR, `${safeEmail}.json`);

  await writeFile(tokenFile, JSON.stringify(tokenData, null, 2));
  console.log(`Token saved for ${email} -> ${tokenFile}`);
}

/**
 * Load token for a specific account
 */
export async function loadToken(email: string): Promise<TokenData | null> {
  const safeEmail = email.replace(/[@.]/g, "_");
  const tokenFile = join(TOKENS_DIR, `${safeEmail}.json`);

  if (!existsSync(tokenFile)) {
    return null;
  }

  const content = await readFile(tokenFile, "utf-8");
  return JSON.parse(content);
}

/**
 * Generate the authorization URL for a user to visit
 */
export async function getAuthUrl(email?: string): Promise<string> {
  const credentials = await loadCredentials();
  const { client_id, redirect_uris } = credentials;

  const params = new URLSearchParams({
    client_id,
    redirect_uri: redirect_uris[0],
    response_type: "code",
    scope: SCOPES.join(" "),
    response_mode: "query",
    prompt: "consent",
  });

  if (email) {
    params.set("login_hint", email);
    params.set("state", email);
  }

  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForToken(
  code: string,
  email: string
): Promise<TokenData> {
  const credentials = await loadCredentials();
  const { client_id, client_secret, redirect_uris } = credentials;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri: redirect_uris[0],
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = await response.json();

  // Determine account type from the token
  const accountType = data.id_token ?
    (JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64').toString()).tid === "9188040d-6c67-4c5b-b112-36a304b66dad"
      ? "personal"
      : "organizational")
    : undefined;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    expiry_date: Date.now() + data.expires_in * 1000,
    email,
    account_type: accountType as "personal" | "organizational" | undefined,
  };
}

/**
 * Refresh an expired access token
 */
export async function refreshAccessToken(email: string): Promise<string> {
  const credentials = await loadCredentials();
  const tokenData = await loadToken(email);

  if (!tokenData) {
    throw new Error(`No token found for ${email}. Run OAuth setup first.`);
  }

  const { client_id, client_secret } = credentials;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokenData.refresh_token,
      client_id,
      client_secret,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data = await response.json();

  // Update token data
  tokenData.access_token = data.access_token;
  tokenData.expiry_date = Date.now() + data.expires_in * 1000;

  // Sometimes refresh_token is not returned, keep the old one
  if (data.refresh_token) {
    tokenData.refresh_token = data.refresh_token;
  }

  await saveToken(email, tokenData);

  return tokenData.access_token;
}

/**
 * Get a valid access token (refresh if needed)
 */
export async function getValidAccessToken(email: string): Promise<string> {
  const tokenData = await loadToken(email);

  if (!tokenData) {
    throw new Error(`No token found for ${email}. Run OAuth setup first.`);
  }

  // Check if token is expired (with 5 minute buffer)
  if (Date.now() >= tokenData.expiry_date - 5 * 60 * 1000) {
    console.log(`[Microsoft OAuth] Refreshing token for ${email}`);
    return refreshAccessToken(email);
  }

  return tokenData.access_token;
}

/**
 * Show auth URL for an account
 */
async function showAuthUrl(email?: string): Promise<void> {
  const authUrl = await getAuthUrl(email);
  console.log(`\n${"=".repeat(60)}`);
  if (email) {
    console.log(`Account: ${email}`);
  } else {
    console.log(`Account: (new account)`);
  }
  console.log("=".repeat(60));
  console.log(`\n1. Visit this URL:\n`);
  console.log(authUrl);
  console.log(`\n2. Authorize the app`);
  console.log(`3. Copy the 'code' from the redirect URL`);
  console.log(`4. Run: bun run src/microsoft-oauth.ts token YOUR_EMAIL YOUR_CODE`);
  console.log("=".repeat(60) + "\n");
}

/**
 * Exchange code for token and save
 */
async function authorizeWithCode(email: string, code: string): Promise<void> {
  console.log(`\nAuthorizing ${email}...`);
  try {
    const tokenData = await exchangeCodeForToken(code, email);
    await saveToken(email, tokenData);
    console.log(`SUCCESS: ${email} authorized!`);
    if (tokenData.account_type) {
      console.log(`Account type: ${tokenData.account_type}`);
    }
  } catch (error) {
    console.error(`FAILED: ${error}`);
    process.exit(1);
  }
}

/**
 * List authorized accounts
 */
async function listAuthorized(): Promise<void> {
  console.log("\nAuthorized Microsoft Accounts:");
  console.log("=".repeat(40));

  const accounts = await discoverAuthorizedAccounts();

  if (accounts.length === 0) {
    console.log("(no accounts authorized)");
  } else {
    for (const email of accounts) {
      const token = await loadToken(email);
      if (token) {
        const expiry = new Date(token.expiry_date);
        const typeStr = token.account_type ? ` [${token.account_type}]` : "";
        console.log(`[OK] ${email}${typeStr} (token expires: ${expiry.toLocaleString()})`);
      }
    }
  }
  console.log("=".repeat(40) + "\n");
}

/**
 * Discover all authorized accounts by scanning the tokens directory
 */
export async function discoverAuthorizedAccounts(): Promise<string[]> {
  if (!existsSync(TOKENS_DIR)) {
    return [];
  }

  const { readdir } = await import('fs/promises');
  const files = await readdir(TOKENS_DIR);

  const accounts: string[] = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      // Convert filename back to email: user_outlook_com.json -> user@outlook.com
      const safeEmail = file.replace('.json', '');
      const email = safeEmail
        .replace(/_([^_]+)_([^_]+)$/, '@$1.$2') // Last two underscores become @ and .
        .replace(/_/g, ''); // Remove remaining underscores (from dots in local part)

      // Verify the token is valid by loading it
      const token = await loadToken(email);
      if (token) {
        accounts.push(email);
      }
    }
  }

  return accounts;
}

/**
 * Check if an account has a valid token (even if expired - refresh token exists)
 */
export async function hasToken(email: string): Promise<boolean> {
  const token = await loadToken(email);
  return token !== null;
}

/**
 * CLI interface
 */
async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // Check credentials file
  if (!existsSync(CREDENTIALS_FILE)) {
    console.log("ERROR: Credentials file not found!");
    console.log(`\n1. Go to: https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade`);
    console.log(`2. Register a new application or use existing`);
    console.log(`3. Add a Web platform with redirect URI (e.g., http://localhost)`);
    console.log(`4. Create a client secret in Certificates & secrets`);
    console.log(`5. Add API permissions: Mail.Read, Mail.Send, Calendars.Read, Files.Read`);
    console.log(`6. Create a JSON file at: ${CREDENTIALS_FILE}`);
    console.log(`   Format: { "client_id": "...", "client_secret": "...", "redirect_uris": ["http://localhost"] }`);
    console.log(`\nThen run this script again.`);
    process.exit(1);
  }

  switch (cmd) {
    case "url":
      // Show auth URL for an account
      const email = args[1];
      await showAuthUrl(email);
      break;

    case "token":
      // Exchange code for token
      const tokenEmail = args[1];
      const code = args[2];
      if (!tokenEmail || !code) {
        console.log("Usage: bun run src/microsoft-oauth.ts token EMAIL CODE");
        console.log("Example: bun run src/microsoft-oauth.ts token user@outlook.com 0.ARo...");
        process.exit(1);
      }
      await authorizeWithCode(tokenEmail, code);
      break;

    case "list":
      // List authorized accounts
      await listAuthorized();
      break;

    case "setup":
    default:
      // Show auth URL for new account
      console.log("\n" + "=".repeat(60));
      console.log("Microsoft OAuth Setup for Claude Agent");
      console.log("=".repeat(60));
      console.log("\nCredentials found. Setting up...\n");

      await showAuthUrl();

      console.log("After authorizing, verify with:");
      console.log("  bun run src/microsoft-oauth.ts list");
      break;
  }
}

// Run CLI if executed directly
if (import.meta.path === process.argv[1] || (process.argv[1] && process.argv[1].endsWith("microsoft-oauth.ts"))) {
  cli().catch(console.error);
}

export { SCOPES, TOKENS_DIR, CREDENTIALS_FILE };
