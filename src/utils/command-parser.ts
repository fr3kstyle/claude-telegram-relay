/**
 * Command Argument Parser Utilities
 *
 * Provides typed argument parsing for Telegram bot commands.
 * Supports quoted strings, flags, positional arguments, and validation.
 */

/**
 * Base result type for all parser operations
 */
export interface ParseResult<T> {
  success: true;
  data: T;
  remaining: string;
}

export interface ParseError {
  success: false;
  error: string;
  usage?: string;
}

export type ParserResult<T> = ParseResult<T> | ParseError;

/**
 * Tokenize a command argument string
 * Handles quoted strings and escaped characters
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '\\' && i + 1 < input.length) {
        // Escape sequence
        const next = input[i + 1];
        if (next === quoteChar || next === '\\') {
          current += next;
          i += 2;
          continue;
        }
      }
      if (char === quoteChar) {
        // End of quoted string
        inQuotes = false;
        quoteChar = '';
        i++;
        continue;
      }
      current += char;
      i++;
    } else {
      if (char === '"' || char === "'") {
        // Start of quoted string
        if (current) {
          tokens.push(current);
          current = '';
        }
        inQuotes = true;
        quoteChar = char;
        i++;
      } else if (/\s/.test(char)) {
        // Whitespace - delimiter
        if (current) {
          tokens.push(current);
          current = '';
        }
        i++;
      } else {
        current += char;
        i++;
      }
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Parse a flag from tokens
 * Supports: --flag value, --flag="value", --flag (boolean)
 */
export function parseFlag(
  tokens: string[],
  flagName: string
): { value: string | boolean; remaining: string[] } | null {
  const flagPattern = `--${flagName}`;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // --flag="value" format
    if (token.startsWith(`${flagPattern}=`)) {
      const value = token.substring(flagPattern.length + 1);
      const remaining = [...tokens.slice(0, i), ...tokens.slice(i + 1)];
      return { value, remaining };
    }

    // --flag value or --flag format
    if (token === flagPattern) {
      const remaining = [...tokens.slice(0, i), ...tokens.slice(i + 1)];

      // Check if next token is a value (not another flag)
      if (i < tokens.length - 1 && !tokens[i + 1].startsWith('--')) {
        return {
          value: tokens[i + 1],
          remaining: [...remaining.slice(0, i), ...remaining.slice(i + 1)]
        };
      }

      // Boolean flag
      return { value: true, remaining };
    }
  }

  return null;
}

/**
 * Parse positional arguments
 */
export function parsePositional(
  tokens: string[],
  index: number
): { value: string; remaining: string[] } | null {
  if (index >= tokens.length) {
    return null;
  }

  // Skip flags when looking for positional
  let actualIndex = 0;
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    if (!tokens[tokenIndex].startsWith('--')) {
      if (actualIndex === index) {
        return {
          value: tokens[tokenIndex],
          remaining: [...tokens.slice(0, tokenIndex), ...tokens.slice(tokenIndex + 1)]
        };
      }
      actualIndex++;
    }
    tokenIndex++;
  }

  return null;
}

/**
 * Extract remaining text after parsing
 */
export function getRemainingText(tokens: string[]): string {
  return tokens.join(' ');
}

/**
 * Common email validation regex
 */
export const EMAIL_REGEX = /^[^\s]+@[^\s]+\.[^\s]+$/;

/**
 * Strict email validation (more RFC-compliant)
 */
export const EMAIL_STRICT_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Parse an email address from input
 */
export function parseEmail(input: string): { email: string; remaining: string } | null {
  const match = input.match(/^([^\s]+@[^\s]+)/);
  if (!match) {
    return null;
  }
  return {
    email: match[1],
    remaining: input.substring(match[1].length).trim()
  };
}

/**
 * Parse a provider type from input
 */
export function parseProvider(input: string): { provider: string; remaining: string } | null {
  const match = input.match(/^(gmail|outlook|imap|smtp)\b/i);
  if (!match) {
    return null;
  }
  return {
    provider: match[1].toLowerCase(),
    remaining: input.substring(match[0].length).trim()
  };
}

/**
 * Parse a display name from --name flag
 */
export function parseDisplayName(input: string): { name: string; remaining: string } | null {
  // Match --name "value" or --name=value
  const quotedMatch = input.match(/--name\s+"([^"]+)"/);
  if (quotedMatch) {
    return {
      name: quotedMatch[1],
      remaining: input.replace(/--name\s+"[^"]+"/, '').trim()
    };
  }

  const equalsMatch = input.match(/--name=(\S+)/);
  if (equalsMatch) {
    return {
      name: equalsMatch[1],
      remaining: input.replace(/--name=\S+/, '').trim()
    };
  }

  return null;
}

// ============================================================================
// Email Add Command Parser
// ============================================================================

import type { EmailProviderType } from '../email/types.ts';

/**
 * Parsed arguments for /email add command
 */
export interface EmailAddArgs {
  /** Email address (normalized to lowercase) */
  email: string;
  /** Explicitly specified provider (optional, auto-detected if not provided) */
  provider?: EmailProviderType;
  /** Display name for the account (optional) */
  displayName?: string;
}

/**
 * Result of parsing /email add arguments
 */
export type EmailAddParseResult = ParserResult<EmailAddArgs>;

/**
 * Usage string for /email add command
 */
export const EMAIL_ADD_USAGE = `Usage: /email add <email> [provider] [--name "Display Name"]

Examples:
  /email add user@gmail.com
  /email add user@company.com gmail --name "Work"
  /email add user@outlook.com outlook

Providers: gmail, outlook`;

/**
 * Sanitize display name for storage
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
 * Validate email address format
 * Uses RFC 5322 basic compliance with practical constraints.
 */
export function validateEmailFormat(email: string): boolean {
  // Length checks (RFC 5321)
  if (!email || email.length > 254) {
    return false;
  }

  // Basic email regex pattern
  if (!EMAIL_STRICT_REGEX.test(email)) {
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
 * Provider domain mappings for auto-detection
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
 * Detect email provider from domain
 */
export function detectProviderFromDomain(email: string): EmailProviderType | null {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) {
    return null;
  }
  return PROVIDER_DOMAINS[domain] || null;
}

/**
 * Check if a provider type is valid
 */
export function isValidProviderType(provider: string): provider is EmailProviderType {
  const validProviders: EmailProviderType[] = ['gmail', 'outlook', 'imap', 'smtp'];
  return validProviders.includes(provider as EmailProviderType);
}

/**
 * Parse /email add command arguments
 *
 * Supports formats:
 * - /email add user@gmail.com
 * - /email add user@company.com gmail
 * - /email add user@outlook.com outlook --name "Work Account"
 * - /email add user@gmail.com --name=Personal
 *
 * Edge cases handled:
 * - Extra whitespace
 * - Case-insensitive email/provider
 * - Quoted display names with spaces
 * - Invalid email format
 * - Unknown provider types
 * - Provider mismatch with email domain
 */
export function parseEmailAddArgs(input: string): EmailAddParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      success: false,
      error: 'No arguments provided',
      usage: EMAIL_ADD_USAGE,
    };
  }

  // Parse email (first positional)
  const emailResult = parseEmail(trimmed);
  if (!emailResult) {
    return {
      success: false,
      error: 'Invalid or missing email address',
      usage: EMAIL_ADD_USAGE,
    };
  }

  let email = emailResult.email.toLowerCase();
  let remaining = emailResult.remaining;

  // Validate email format
  if (!validateEmailFormat(email)) {
    return {
      success: false,
      error: `Invalid email format: ${emailResult.email}`,
      usage: EMAIL_ADD_USAGE,
    };
  }

  // Parse provider (optional second positional)
  let provider: EmailProviderType | undefined;
  if (remaining) {
    const providerResult = parseProvider(remaining);
    if (providerResult) {
      provider = providerResult.provider as EmailProviderType;
      remaining = providerResult.remaining;
    }
  }

  // Parse display name (optional --name flag)
  let displayName: string | undefined;
  if (remaining) {
    const nameResult = parseDisplayName(remaining);
    if (nameResult) {
      displayName = sanitizeDisplayName(nameResult.name);
      remaining = nameResult.remaining;
    }
  }

  // Check for unexpected arguments
  if (remaining.trim()) {
    // Allow some slack for minor issues but warn about unrecognized content
    const unexpected = remaining.trim();
    if (unexpected.startsWith('--')) {
      return {
        success: false,
        error: `Unknown flag: ${unexpected.split(/\s/)[0]}`,
        usage: EMAIL_ADD_USAGE,
      };
    }
  }

  // Auto-detect provider if not specified
  const detectedProvider = detectProviderFromDomain(email);

  // Validate provider consistency
  if (provider && detectedProvider && provider !== detectedProvider) {
    // User specified a different provider than what domain suggests
    // This might be intentional for custom domains, so allow it but note
    // (Validation layer above should handle warnings if needed)
  }

  // Use detected provider if not explicitly specified
  const finalProvider = provider || detectedProvider;

  return {
    success: true,
    data: {
      email,
      provider: finalProvider,
      displayName,
    },
    remaining,
  };
}

// ============================================================================
// OAuth Code Validation
// ============================================================================

/**
 * OAuth provider code patterns
 * Google codes: start with "4/", contain forward slashes
 * Microsoft codes: start with "M.", contain dots and underscores
 */
export const GOOGLE_CODE_PATTERN = /^4\/[A-Za-z0-9_\-+/]+$/;
export const MICROSOFT_CODE_PATTERN = /^M\.[A-Za-z0-9_.\-]+$/;

/**
 * Detected OAuth code provider type
 */
export type CodeProviderType = 'google' | 'microsoft' | 'unknown';

/**
 * Result of code format detection
 */
export interface CodeDetectionResult {
  /** Detected provider type */
  provider: CodeProviderType;
  /** Whether the code appears valid for the detected provider */
  isValid: boolean;
  /** Human-readable description of the detected format */
  description: string;
}

/**
 * Detect OAuth code provider from format
 *
 * Google OAuth codes typically:
 * - Start with "4/"
 * - Contain forward slashes, underscores, hyphens
 * - Are relatively long (40+ chars)
 *
 * Microsoft OAuth codes typically:
 * - Start with "M."
 * - Contain dots, underscores, hyphens
 * - Include region identifiers like "BAY", "SN1"
 */
export function detectCodeProvider(code: string): CodeDetectionResult {
  const trimmed = code.trim();

  // Empty code
  if (!trimmed) {
    return {
      provider: 'unknown',
      isValid: false,
      description: 'Empty authorization code',
    };
  }

  // Check for Google format
  if (GOOGLE_CODE_PATTERN.test(trimmed)) {
    return {
      provider: 'google',
      isValid: trimmed.length >= 20, // Reasonable minimum length
      description: 'Google OAuth code (starts with 4/)',
    };
  }

  // Check for Microsoft format
  if (MICROSOFT_CODE_PATTERN.test(trimmed)) {
    return {
      provider: 'microsoft',
      isValid: trimmed.length >= 20, // Reasonable minimum length
      description: 'Microsoft OAuth code (starts with M.)',
    };
  }

  // Heuristic detection for partial/modified codes
  if (trimmed.startsWith('4/')) {
    return {
      provider: 'google',
      isValid: true, // Assume valid if it starts correctly
      description: 'Likely Google OAuth code (starts with 4/)',
    };
  }

  if (trimmed.startsWith('M.') || trimmed.startsWith('M.C')) {
    return {
      provider: 'microsoft',
      isValid: true, // Assume valid if it starts correctly
      description: 'Likely Microsoft OAuth code (starts with M.)',
    };
  }

  // Unknown format - might still be valid for custom OAuth flows
  return {
    provider: 'unknown',
    isValid: trimmed.length >= 10, // Basic length check
    description: 'Unrecognized code format',
  };
}

/**
 * Validate that code format matches expected email provider
 * Returns null if valid, or an error message if mismatch
 */
export function validateCodeForProvider(
  code: string,
  emailProvider: EmailProviderType
): string | null {
  const detection = detectCodeProvider(code);

  // If we can't detect the format, allow it (might be custom flow)
  if (detection.provider === 'unknown') {
    return null;
  }

  // Check for mismatches
  if (emailProvider === 'gmail' && detection.provider === 'microsoft') {
    return `Code appears to be a Microsoft OAuth code but email provider is Gmail. ` +
           `Please use the code from your Google authorization.`;
  }

  if (emailProvider === 'outlook' && detection.provider === 'google') {
    return `Code appears to be a Google OAuth code but email provider is Outlook. ` +
           `Please use the code from your Microsoft authorization.`;
  }

  // Warn about potentially too-short codes
  if (!detection.isValid && detection.provider !== 'unknown') {
    return `Code appears incomplete or truncated. Please paste the full authorization code.`;
  }

  return null;
}

// ============================================================================
// Email Verify Command Parser
// ============================================================================

/**
 * Parsed arguments for /email verify command
 */
export interface EmailVerifyArgs {
  /** Email address (normalized to lowercase) */
  email: string;
  /** OAuth authorization code (may contain spaces if URL-encoded) */
  code: string;
  /** Detected code provider (optional, set during validation) */
  codeProvider?: CodeProviderType;
}

/**
 * Result of parsing /email verify arguments
 */
export type EmailVerifyParseResult = ParserResult<EmailVerifyArgs>;

/**
 * Usage string for /email verify command
 */
export const EMAIL_VERIFY_USAGE = `Usage: /email verify <email> <authorization_code>

After authorizing with /email add, paste the code you received.
The authorization code may be long and contain special characters.`;

/**
 * Parse /email verify command arguments
 *
 * Supports formats:
 * - /email verify user@gmail.com 4/0AX4XfWh...
 * - /email verify user@outlook.com "code with spaces"
 *
 * Edge cases handled:
 * - Codes with spaces (URL-encoded)
 * - Extra whitespace
 * - Case-insensitive email
 * - Invalid email format
 * - Missing email or code
 * - Code format validation (Google vs Microsoft)
 */
export function parseEmailVerifyArgs(
  input: string,
  options?: { validateCodeFormat?: boolean }
): EmailVerifyParseResult {
  const trimmed = input.trim();
  const shouldValidateCode = options?.validateCodeFormat ?? false;

  if (!trimmed) {
    return {
      success: false,
      error: 'No arguments provided',
      usage: EMAIL_VERIFY_USAGE,
    };
  }

  // Parse email (first positional)
  const emailResult = parseEmail(trimmed);
  if (!emailResult) {
    return {
      success: false,
      error: 'Invalid or missing email address',
      usage: EMAIL_VERIFY_USAGE,
    };
  }

  const email = emailResult.email.toLowerCase();
  const code = emailResult.remaining.trim();

  // Validate email format
  if (!validateEmailFormat(email)) {
    return {
      success: false,
      error: `Invalid email format: ${emailResult.email}`,
      usage: EMAIL_VERIFY_USAGE,
    };
  }

  // Check for missing code
  if (!code) {
    return {
      success: false,
      error: 'Missing authorization code',
      usage: EMAIL_VERIFY_USAGE,
    };
  }

  // Detect code provider for informational purposes
  const codeDetection = detectCodeProvider(code);

  // Optional: validate code format matches email provider
  if (shouldValidateCode) {
    const emailProvider = detectProviderFromDomain(email);
    if (emailProvider) {
      const validationError = validateCodeForProvider(code, emailProvider);
      if (validationError) {
        return {
          success: false,
          error: validationError,
          usage: EMAIL_VERIFY_USAGE,
        };
      }
    }
  }

  return {
    success: true,
    data: {
      email,
      code,
      codeProvider: codeDetection.provider,
    },
    remaining: '',
  };
}
