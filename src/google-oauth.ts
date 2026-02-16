/**
 * Google OAuth 2.0 Handler
 *
 * Handles authentication for Gmail, Calendar, and Drive APIs.
 * Supports multiple Google accounts.
 *
 * Usage:
 * 1. Run: bun run src/google-oauth.ts
 * 2. Visit the printed URL for each account
 * 3. Authorize and copy the code
 * 4. Tokens are saved to ~/.claude-relay/google-tokens/
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const TOKENS_DIR = join(RELAY_DIR, "google-tokens");
const CREDENTIALS_FILE = join(RELAY_DIR, "google-credentials.json");

// Google OAuth endpoints
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Required scopes for Gmail, Calendar, and Drive
const SCOPES = [
  // Gmail
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  // Calendar
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  // Drive
  "https://www.googleapis.com/auth/drive",
];

interface Credentials {
  web: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  email: string;
}

/**
 * Load credentials from the JSON file downloaded from Google Cloud Console
 */
async function loadCredentials(): Promise<Credentials> {
  if (!existsSync(CREDENTIALS_FILE)) {
    throw new Error(
      `Credentials file not found: ${CREDENTIALS_FILE}\n` +
      `Download it from Google Cloud Console > APIs & Services > Credentials\n` +
      `Save as: ${CREDENTIALS_FILE}`
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
  console.log(`Token saved for ${email} → ${tokenFile}`);
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
export async function getAuthUrl(email: string): Promise<string> {
  const credentials = await loadCredentials();
  const { client_id, redirect_uris } = credentials.web;

  const params = new URLSearchParams({
    client_id,
    redirect_uri: redirect_uris[0],
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    login_hint: email,
    state: email, // Pass email in state to identify which account
  });

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
  const { client_id, client_secret, redirect_uris } = credentials.web;

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

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    expiry_date: Date.now() + data.expires_in * 1000,
    email,
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

  const { client_id, client_secret } = credentials.web;

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

  await saveToken(email, tokenData);

  return tokenData.access_token;
}

/**
 * Get a valid access token (refresh if needed)
 *
 * Tries database storage first (encrypted), falls back to file storage.
 * This allows gradual migration from file-based to database tokens.
 */
export async function getValidAccessToken(email: string): Promise<string> {
  // Try database storage first
  try {
    const { getTokenManager } = await import('./auth/token-manager.ts');
    const tokenManager = getTokenManager();

    // Register refresh callback for Google
    tokenManager.registerRefreshCallback('google', async (refreshToken: string) => {
      const credentials = await loadCredentials();
      const { client_id, client_secret } = credentials.web;

      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: refreshToken,
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
      return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
      };
    });

    // Try to get token from database
    if (await tokenManager.hasToken('google', email)) {
      return tokenManager.getAccessToken('google', email);
    }
  } catch (err) {
    // Database not available, fall back to file storage
    console.log(`[OAuth] Database storage unavailable, using file storage for ${email}`);
  }

  // Fall back to file-based token storage
  const tokenData = await loadToken(email);

  if (!tokenData) {
    throw new Error(`No token found for ${email}. Run OAuth setup first.`);
  }

  // Check if token is expired (with 5 minute buffer)
  if (Date.now() >= tokenData.expiry_date - 5 * 60 * 1000) {
    console.log(`[OAuth] Refreshing token for ${email}`);
    return refreshAccessToken(email);
  }

  return tokenData.access_token;
}

/**
 * Show auth URL for an account
 */
async function showAuthUrl(email: string): Promise<void> {
  const authUrl = await getAuthUrl(email);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Account: ${email}`);
  console.log("=".repeat(60));
  console.log(`\n1. Visit this URL:\n`);
  console.log(authUrl);
  console.log(`\n2. Authorize the app`);
  console.log(`3. Copy the 'code' from the redirect URL`);
  console.log(`4. Run: bun run src/google-oauth.ts token ${email} YOUR_CODE`);
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
  } catch (error) {
    console.error(`FAILED: ${error}`);
    process.exit(1);
  }
}

/**
 * List authorized accounts
 */
async function listAuthorized(): Promise<void> {
  console.log("\nAuthorized Google Accounts:");
  console.log("=".repeat(40));

  const accounts = ["Fr3kchy@gmail.com", "fr3k@mcpintelligence.com.au"];

  for (const email of accounts) {
    const token = await loadToken(email);
    if (token) {
      const expiry = new Date(token.expiry_date);
      console.log(`[OK] ${email} (token expires: ${expiry.toLocaleString()})`);
    } else {
      console.log(`[ ]  ${email} (not authorized)`);
    }
  }
  console.log("=".repeat(40) + "\n");
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
    console.log(`\n1. Go to: https://console.cloud.google.com/apis/credentials`);
    console.log(`2. Create OAuth client ID (Web application)`);
    console.log(`3. Download the JSON file`);
    console.log(`4. Save it to: ${CREDENTIALS_FILE}`);
    console.log(`\nThen run this script again.`);
    process.exit(1);
  }

  switch (cmd) {
    case "url":
      // Show auth URL for an account
      const email = args[1];
      if (!email) {
        console.log("Usage: bun run src/google-oauth.ts url EMAIL");
        console.log("Example: bun run src/google-oauth.ts url Fr3kchy@gmail.com");
        process.exit(1);
      }
      await showAuthUrl(email);
      break;

    case "token":
      // Exchange code for token
      const tokenEmail = args[1];
      const code = args[2];
      if (!tokenEmail || !code) {
        console.log("Usage: bun run src/google-oauth.ts token EMAIL CODE");
        console.log("Example: bun run src/google-oauth.ts token Fr3kchy@gmail.com 4/0AX...");
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
      // Show all auth URLs
      console.log("\n" + "=".repeat(60));
      console.log("Google OAuth Setup for Claude Agent");
      console.log("=".repeat(60));
      console.log("\nCredentials found. Setting up accounts...\n");

      const accounts = ["Fr3kchy@gmail.com", "fr3k@mcpintelligence.com.au"];

      for (const email of accounts) {
        await showAuthUrl(email);
      }

      console.log("After authorizing all accounts, verify with:");
      console.log("  bun run src/google-oauth.ts list");
      break;
  }
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
      // Convert filename back to email: Fr3kchy_gmail_com.json -> Fr3kchy@gmail.com
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

// Run CLI if executed directly
if (import.meta.path === process.argv[1] || (process.argv[1] && process.argv[1].endsWith("google-oauth.ts"))) {
  cli().catch(console.error);
}

export { SCOPES, TOKENS_DIR, CREDENTIALS_FILE };
