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
