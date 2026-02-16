/**
 * Encryption Utilities
 *
 * Provides AES-256-GCM encryption/decryption for sensitive data like OAuth tokens.
 * Uses PBKDF2 for key derivation from an environment variable.
 *
 * Usage:
 *   const encrypted = await encrypt(JSON.stringify(token));
 *   const decrypted = await decrypt(encrypted);
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

// Configuration
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

/**
 * Get the encryption key from environment
 * Falls back to a development key if not set (with warning)
 */
function getEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;

  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY environment variable is required in production');
    }
    console.warn('[Encryption] WARNING: Using development encryption key. Set ENCRYPTION_KEY for production.');
    // Development fallback - DO NOT use in production
    return 'dev-encryption-key-DO-NOT-USE-IN-PRODUCTION';
  }

  if (key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }

  return key;
}

/**
 * Derive a cryptographic key from the master key using PBKDF2
 */
function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return pbkdf2Sync(masterKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt data using AES-256-GCM
 *
 * @param plaintext - The data to encrypt
 * @returns Base64-encoded encrypted data with salt, IV, and auth tag
 */
export async function encrypt(plaintext: string): Promise<string> {
  const masterKey = getEncryptionKey();

  // Generate random salt and IV
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // Derive key
  const key = deriveKey(masterKey, salt);

  // Create cipher
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  // Encrypt
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // Get auth tag
  const authTag = cipher.getAuthTag();

  // Combine: salt (32) + iv (16) + authTag (16) + encrypted data
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);

  return combined.toString('base64');
}

/**
 * Decrypt data that was encrypted with encrypt()
 *
 * @param ciphertext - Base64-encoded encrypted data
 * @returns The decrypted plaintext
 */
export async function decrypt(ciphertext: string): Promise<string> {
  const masterKey = getEncryptionKey();

  // Decode base64
  const combined = Buffer.from(ciphertext, 'base64');

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  // Derive key
  const key = deriveKey(masterKey, salt);

  // Create decipher
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  // Decrypt
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Encrypt a JSON object
 */
export async function encryptJSON<T>(data: T): Promise<string> {
  return encrypt(JSON.stringify(data));
}

/**
 * Decrypt to a JSON object
 */
export async function decryptJSON<T>(ciphertext: string): Promise<T> {
  const plaintext = await decrypt(ciphertext);
  return JSON.parse(plaintext);
}

/**
 * Generate a new encryption key for setup
 * Run this once and store in environment
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Check if encryption is properly configured
 */
export function isEncryptionConfigured(): boolean {
  return !!process.env.ENCRYPTION_KEY;
}
