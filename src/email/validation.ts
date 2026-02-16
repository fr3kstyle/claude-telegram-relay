/**
 * Email Validation Utilities
 *
 * Provides validation functions for email addresses and provider detection.
 */

import type { EmailProviderType } from './types.ts';

/**
 * Validate email address format
 *
 * Uses RFC 5322 basic compliance with practical constraints.
 * - Max length: 254 characters (RFC 5321)
 * - Local part: 1-64 characters
 * - Domain: valid DNS format
 *
 * @param email - Email address to validate
 * @returns true if valid, false otherwise
 */
export function validateEmail(email: string): boolean {
  // Length checks
  if (!email || email.length > 254) {
    return false;
  }

  // Basic email regex pattern (practical RFC 5322)
  // Allows: letters, numbers, dots, hyphens, underscores, plus signs
  // Requires: @ symbol, domain with at least one dot
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

  if (!emailRegex.test(email)) {
    return false;
  }

  // Split and validate parts
  const [localPart, domain] = email.split('@');

  // Local part length check
  if (localPart.length > 64) {
    return false;
  }

  // Domain validation
  if (domain.length < 1 || domain.length > 253) {
    return false;
  }

  // Check for consecutive dots
  if (/\.\./.test(email)) {
    return false;
  }

  // Check that domain has valid TLD (at least 2 chars)
  const domainParts = domain.split('.');
  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2) {
    return false;
  }

  return true;
}

/**
 * Provider domain mappings
 */
const PROVIDER_DOMAINS: Record<string, EmailProviderType> = {
  // Gmail
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',

  // Outlook/Microsoft
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'passport.com': 'outlook',
  'hotmail.co.uk': 'outlook',
  'hotmail.fr': 'outlook',
  'hotmail.de': 'outlook',
  'outlook.es': 'outlook',
};

/**
 * Detect email provider from email address domain
 *
 * @param email - Email address to analyze
 * @returns Detected provider type or null if unknown
 */
export function detectProviderFromEmail(email: string): EmailProviderType | null {
  if (!validateEmail(email)) {
    return null;
  }

  const domain = email.split('@')[1]?.toLowerCase();

  if (!domain) {
    return null;
  }

  return PROVIDER_DOMAINS[domain] || null;
}

/**
 * Check if a provider type is supported
 *
 * @param provider - Provider type string to validate
 * @returns true if valid provider type
 */
export function isValidProviderType(provider: string): provider is EmailProviderType {
  const validProviders: EmailProviderType[] = ['gmail', 'outlook'];
  return validProviders.includes(provider as EmailProviderType);
}

/**
 * Get display name for provider type
 */
export function getProviderDisplayName(provider: EmailProviderType): string {
  const names: Record<EmailProviderType, string> = {
    gmail: 'Gmail',
    outlook: 'Outlook/Microsoft',
  };
  return names[provider] || provider;
}

/**
 * Sanitize display name for storage
 *
 * Removes potentially harmful characters and limits length.
 */
export function sanitizeDisplayName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }

  // Remove control characters and limit length
  const sanitized = name
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .substring(0, 100);

  return sanitized || undefined;
}

/**
 * Validation result with details
 */
export interface EmailValidationResult {
  valid: boolean;
  email?: string;
  provider?: EmailProviderType;
  error?: string;
}

/**
 * Comprehensive email validation with provider detection
 *
 * @param input - Email address to validate
 * @param expectedProvider - Optional expected provider type
 * @returns Validation result with details
 */
export function validateEmailWithProvider(
  input: string,
  expectedProvider?: EmailProviderType
): EmailValidationResult {
  // Trim and lowercase
  const email = input.trim().toLowerCase();

  // Basic format validation
  if (!validateEmail(email)) {
    return {
      valid: false,
      error: 'Invalid email address format',
    };
  }

  // Detect provider
  const detectedProvider = detectProviderFromEmail(email);

  // If expected provider specified, verify match
  if (expectedProvider && detectedProvider !== expectedProvider) {
    // Allow manual override for custom domains
    if (!detectedProvider) {
      return {
        valid: true,
        email,
        provider: expectedProvider,
      };
    }

    return {
      valid: false,
      email,
      provider: detectedProvider,
      error: `Email domain suggests ${getProviderDisplayName(detectedProvider)}, not ${getProviderDisplayName(expectedProvider)}`,
    };
  }

  return {
    valid: true,
    email,
    provider: detectedProvider || expectedProvider,
  };
}

/**
 * OAuth error categories for user-friendly messaging
 */
export type OAuthErrorCategory =
  | 'invalid_code'
  | 'expired_code'
  | 'already_used'
  | 'network'
  | 'credentials'
  | 'access_denied'
  | 'rate_limited'
  | 'unknown';

/**
 * Parsed OAuth error with user-friendly message
 */
export interface ParsedOAuthError {
  category: OAuthErrorCategory;
  userMessage: string;
  suggestion: string;
}

/**
 * Parse OAuth error response and return user-friendly message
 *
 * Handles errors from both Google and Microsoft OAuth endpoints.
 *
 * @param error - Raw error message or response from OAuth provider
 * @returns Parsed error with category and suggestions
 */
export function parseOAuthError(error: string): ParsedOAuthError {
  const errorLower = error.toLowerCase();

  // Invalid authorization code
  if (
    errorLower.includes('invalid_grant') ||
    errorLower.includes('invalid authorization code') ||
    errorLower.includes('authorization code is invalid') ||
    errorLower.includes('bad request')
  ) {
    return {
      category: 'invalid_code',
      userMessage: 'The authorization code is invalid or malformed.',
      suggestion: 'Make sure you copied the entire code from the redirect URL.',
    };
  }

  // Expired code
  if (
    errorLower.includes('expired') ||
    errorLower.includes('code has expired') ||
    errorLower.includes('stale')
  ) {
    return {
      category: 'expired_code',
      userMessage: 'The authorization code has expired.',
      suggestion: 'Codes are only valid for a few minutes. Start the process again with /email add.',
    };
  }

  // Already used code
  if (
    errorLower.includes('already used') ||
    errorLower.includes('replay') ||
    errorLower.includes('code was already redeemed')
  ) {
    return {
      category: 'already_used',
      userMessage: 'This authorization code has already been used.',
      suggestion: 'Each code can only be used once. Start fresh with /email add.',
    };
  }

  // Network/connectivity issues
  if (
    errorLower.includes('network') ||
    errorLower.includes('econnrefused') ||
    errorLower.includes('enotfound') ||
    errorLower.includes('timeout') ||
    errorLower.includes('fetch failed')
  ) {
    return {
      category: 'network',
      userMessage: 'Network error connecting to the OAuth provider.',
      suggestion: 'Check your internet connection and try again.',
    };
  }

  // Credentials/configuration issues
  if (
    errorLower.includes('unauthorized_client') ||
    errorLower.includes('invalid_client') ||
    errorLower.includes('redirect_uri_mismatch') ||
    errorLower.includes('credentials') ||
    errorLower.includes('client_id') ||
    errorLower.includes('client_secret')
  ) {
    return {
      category: 'credentials',
      userMessage: 'OAuth credentials are missing or misconfigured.',
      suggestion: 'Contact the administrator to check the OAuth app configuration.',
    };
  }

  // Access denied by user
  if (
    errorLower.includes('access_denied') ||
    errorLower.includes('consent') ||
    errorLower.includes('permission')
  ) {
    return {
      category: 'access_denied',
      userMessage: 'Access was denied during authorization.',
      suggestion: 'Make sure to grant all requested permissions when prompted.',
    };
  }

  // Rate limiting
  if (
    errorLower.includes('rate limit') ||
    errorLower.includes('too many requests') ||
    errorLower.includes('429')
  ) {
    return {
      category: 'rate_limited',
      userMessage: 'Too many authorization attempts.',
      suggestion: 'Wait a few minutes before trying again.',
    };
  }

  // Unknown error - provide raw message
  return {
    category: 'unknown',
    userMessage: `Authorization failed: ${error.substring(0, 200)}`,
    suggestion: 'Try /email add again to get a fresh authorization URL.',
  };
}
