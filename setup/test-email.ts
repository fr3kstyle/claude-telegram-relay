/**
 * Claude Telegram Relay — Test Email Providers
 *
 * Verifies email provider connectivity for all configured accounts.
 * Tests authentication, lists recent messages, and validates provider capabilities.
 *
 * Usage: bun run test:email
 */

import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

// Load .env manually
async function loadEnv(): Promise<Record<string, string>> {
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = await Bun.file(envPath).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

async function main() {
  console.log("");
  console.log(bold("  Email Provider Connection Test"));
  console.log("");

  const env = await loadEnv();

  // Set env vars before importing modules that need them
  for (const [key, value] of Object.entries(env)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  // Check Supabase configuration
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    console.log(`  ${FAIL} SUPABASE_URL not set in .env`);
    process.exit(1);
  }
  console.log(`  ${PASS} Supabase URL: ${supabaseUrl.substring(0, 30)}...`);

  if (!supabaseKey) {
    console.log(`  ${FAIL} SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY not set`);
    process.exit(1);
  }
  console.log(`  ${PASS} Supabase key found`);

  // Import email modules after env is set
  console.log(`\n  ${dim("Loading email module...")}`);
  const { getEmailProviderFactory, getAuthorizedProviders } = await import("../src/email/provider-factory.ts");

  // Discover accounts
  console.log(`\n  ${cyan("Discovering email accounts...")}`);
  const factory = getEmailProviderFactory();

  let accounts: any[] = [];
  try {
    accounts = await factory.discoverAccounts();
    if (accounts.length === 0) {
      console.log(`  ${WARN} No accounts found in database`);
    } else {
      console.log(`  ${PASS} Found ${accounts.length} account(s) in configuration`);
      for (const account of accounts) {
        console.log(`      ${dim("-")} ${account.emailAddress} (${account.providerType})`);
      }
    }
  } catch (err: any) {
    console.log(`  ${WARN} Database discovery failed: ${err.message}`);
    console.log(`      ${dim("Using fallback accounts...")}`);
  }

  // Test each provider
  console.log(`\n  ${cyan("Testing provider authentication...")}`);

  let providers: Map<string, any>;
  try {
    providers = await getAuthorizedProviders();
  } catch (err: any) {
    console.log(`  ${FAIL} Failed to get providers: ${err.message}`);
    process.exit(1);
  }

  if (providers.size === 0) {
    console.log(`  ${FAIL} No authenticated email providers found`);
    console.log(`\n      ${dim("To set up Gmail OAuth:")}`);
    console.log(`      ${dim("  1. Run: bun run setup/google-oauth.ts")}`);
    console.log(`      ${dim("  2. Complete the OAuth flow in your browser")}`);
    console.log(`      ${dim("  3. Run this test again")}`);
    process.exit(1);
  }

  console.log(`  ${PASS} ${providers.size} provider(s) authenticated`);
  console.log("");

  // Test each provider's capabilities
  let totalErrors = 0;
  let totalMessages = 0;

  for (const [email, provider] of providers) {
    console.log(`  ${bold(email)}`);

    // Get provider info
    try {
      const info = await provider.getProviderInfo();
      console.log(`    ${PASS} Type: ${info.type}`);
      console.log(`    ${PASS} Capabilities:`);
      console.log(`        - Send: ${info.capabilities.canSend ? green("yes") : red("no")}`);
      console.log(`        - Search: ${info.capabilities.canSearch ? green("yes") : red("no")}`);
      console.log(`        - Threading: ${info.capabilities.supportsThreads ? green("yes") : red("no")}`);
    } catch (err: any) {
      console.log(`    ${FAIL} Could not get provider info: ${err.message}`);
      totalErrors++;
    }

    // Try to list messages
    try {
      const result = await provider.listMessages({ maxResults: 3 });
      console.log(`    ${PASS} Listed ${result.messages.length} recent message(s)`);
      totalMessages += result.messages.length;

      for (const msg of result.messages.slice(0, 2)) {
        const subject = msg.subject?.substring(0, 40) || "(no subject)";
        const from = msg.from?.name || msg.from?.address || "Unknown";
        console.log(`        ${dim("-")} ${subject}`);
        console.log(`          ${dim("From:")} ${from}`);
      }
    } catch (err: any) {
      console.log(`    ${FAIL} Could not list messages: ${err.message}`);
      totalErrors++;
    }

    console.log("");
  }

  // Summary
  console.log(bold("  Summary"));
  console.log(`    Providers tested: ${providers.size}`);
  console.log(`    Total errors: ${totalErrors === 0 ? green("0") : red(totalErrors.toString())}`);
  console.log(`    Messages fetched: ${totalMessages}`);
  console.log("");

  if (totalErrors > 0) {
    console.log(`  ${yellow("Some tests failed. Check the errors above.")}`);
    process.exit(1);
  }

  console.log(`  ${green("All good!")} Your email providers are configured correctly.`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
