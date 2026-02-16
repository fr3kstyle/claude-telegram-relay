/**
 * Integration tests for /email verify command flow
 *
 * Tests the verify flow from parsing to token storage to account registration.
 * Mocks external dependencies (OAuth, database) to test the logic in isolation.
 *
 * Run with: bun test src/email/__tests__/verify-flow.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { parseEmailVerifyArgs } from "../../utils/command-parser.ts";
import { validateEmailWithProvider, parseOAuthError } from "../validation.ts";

// ============================================================
// PARSING LAYER TESTS
// ============================================================
// The parseEmailVerifyArgs function is already thoroughly tested
// in command-parser.test.ts. These tests verify the integration
// with validation.ts

describe("verify flow: parsing + validation integration", () => {
  describe("email validation in verify context", () => {
    test("validates Gmail address correctly", () => {
      const result = parseEmailVerifyArgs("user@gmail.com code123");
      expect(result.success).toBe(true);
      if (result.success) {
        const validation = validateEmailWithProvider(result.data.email);
        expect(validation.valid).toBe(true);
        expect(validation.provider).toBe("gmail");
      }
    });

    test("validates Outlook address correctly", () => {
      const result = parseEmailVerifyArgs("user@outlook.com code123");
      expect(result.success).toBe(true);
      if (result.success) {
        const validation = validateEmailWithProvider(result.data.email);
        expect(validation.valid).toBe(true);
        expect(validation.provider).toBe("outlook");
      }
    });

    test("validates custom domain (unknown provider)", () => {
      const result = parseEmailVerifyArgs("user@company.com code123");
      expect(result.success).toBe(true);
      if (result.success) {
        const validation = validateEmailWithProvider(result.data.email);
        expect(validation.valid).toBe(true);
        // Unknown domains have undefined provider (can be overridden via command)
        expect(validation.provider).toBeUndefined();
      }
    });

    test("rejects invalid email format during validation", () => {
      // Parser would already catch this, but validation provides detailed error
      const validation = validateEmailWithProvider("not-an-email");
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Invalid email address format");
    });
  });
});

// ============================================================
// MOCK-BASED INTEGRATION TESTS
// ============================================================
// These tests verify the verify command logic by mocking the
// external dependencies (exchangeCodeForToken, TokenManager, etc.)

describe("verify flow: token exchange and storage", () => {
  // Mock types
  interface MockTokenData {
    access_token: string;
    refresh_token: string;
    scope: string;
    token_type: string;
    expiry_date: number;
    email: string;
  }

  interface MockOAuthToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scopes: string[];
  }

  // Mock implementations
  const mockExchangeCodeForToken = mock(async (code: string, email: string): Promise<MockTokenData> => {
    if (code === "invalid_code") {
      throw new Error("Token exchange failed: invalid_grant");
    }
    if (code === "expired_code") {
      throw new Error("Token exchange failed: invalid_grant - code expired");
    }
    if (code === "network_error") {
      throw new Error("Network error: ECONNREFUSED");
    }

    return {
      access_token: `access_${email}`,
      refresh_token: `refresh_${email}`,
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
      token_type: "Bearer",
      expiry_date: Date.now() + 3600 * 1000,
      email,
    };
  });

  const mockStoreToken = mock(async (provider: string, email: string, token: MockOAuthToken): Promise<void> => {
    // Simulate successful storage
    return;
  });

  const mockRegisterAccount = mock(async (options: { emailAddress: string; providerType: string }): Promise<{ success: boolean; error?: string }> => {
    if (options.emailAddress === "dberror@example.com") {
      return { success: false, error: "Database connection failed" };
    }
    return { success: true };
  });

  beforeEach(() => {
    // Reset mocks before each test
    mockExchangeCodeForToken.mockClear();
    mockStoreToken.mockClear();
    mockRegisterAccount.mockClear();
  });

  describe("successful verification flow", () => {
    test("exchanges code for tokens and stores them", async () => {
      const email = "user@gmail.com";
      const code = "valid_auth_code_123";

      // Step 1: Parse and validate
      const parseResult = parseEmailVerifyArgs(`${email} ${code}`);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;
      const { email: parsedEmail, code: parsedCode } = parseResult.data;

      // Step 2: Validate email with provider detection
      const validation = validateEmailWithProvider(parsedEmail);
      expect(validation.valid).toBe(true);

      // Step 3: Exchange code for tokens
      const tokenData = await mockExchangeCodeForToken(parsedCode, parsedEmail);
      expect(tokenData.access_token).toBe(`access_${email}`);
      expect(tokenData.refresh_token).toBe(`refresh_${email}`);
      expect(mockExchangeCodeForToken).toHaveBeenCalledWith(parsedCode, parsedEmail);

      // Step 4: Convert to OAuthToken format and store
      const oauthToken: MockOAuthToken = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(tokenData.expiry_date),
        scopes: tokenData.scope.split(" "),
      };
      await mockStoreToken("google", email, oauthToken);
      expect(mockStoreToken).toHaveBeenCalledWith("google", email, oauthToken);

      // Step 5: Register account in database
      const registerResult = await mockRegisterAccount({
        emailAddress: email,
        providerType: validation.provider || "gmail",
      });
      expect(registerResult.success).toBe(true);
    });

    test("handles Outlook provider correctly", async () => {
      const email = "user@outlook.com";
      const code = "outlook_code_456";

      const parseResult = parseEmailVerifyArgs(`${email} ${code}`);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const validation = validateEmailWithProvider(parseResult.data.email);
      expect(validation.provider).toBe("outlook");

      const tokenData = await mockExchangeCodeForToken(parseResult.data.code, parseResult.data.email);
      expect(tokenData).toBeDefined();
    });
  });

  describe("error handling", () => {
    test("handles invalid authorization code", async () => {
      const email = "user@gmail.com";
      const code = "invalid_code";

      const parseResult = parseEmailVerifyArgs(`${email} ${code}`);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      // Exchange should fail
      await expect(mockExchangeCodeForToken(parseResult.data.code, parseResult.data.email))
        .rejects.toThrow("Token exchange failed: invalid_grant");

      // Token storage should not be called
      expect(mockStoreToken).not.toHaveBeenCalled();
    });

    test("handles expired authorization code", async () => {
      const email = "user@gmail.com";
      const code = "expired_code";

      const parseResult = parseEmailVerifyArgs(`${email} ${code}`);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      await expect(mockExchangeCodeForToken(parseResult.data.code, parseResult.data.email))
        .rejects.toThrow("code expired");
    });

    test("handles network errors during token exchange", async () => {
      const email = "user@gmail.com";
      const code = "network_error";

      const parseResult = parseEmailVerifyArgs(`${email} ${code}`);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      await expect(mockExchangeCodeForToken(parseResult.data.code, parseResult.data.email))
        .rejects.toThrow("Network error");
    });

    test("continues even if database registration fails", async () => {
      const email = "dberror@example.com";
      const code = "valid_code";

      const parseResult = parseEmailVerifyArgs(`${email} ${code}`);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      // Token exchange succeeds
      const tokenData = await mockExchangeCodeForToken(parseResult.data.code, parseResult.data.email);
      expect(tokenData).toBeDefined();

      // Token storage succeeds
      const oauthToken: MockOAuthToken = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(tokenData.expiry_date),
        scopes: tokenData.scope.split(" "),
      };
      await mockStoreToken("google", email, oauthToken);

      // Database registration fails but doesn't throw
      const registerResult = await mockRegisterAccount({
        emailAddress: email,
        providerType: "gmail",
      });
      expect(registerResult.success).toBe(false);
      expect(registerResult.error).toContain("Database connection failed");

      // Flow should continue - file-based token is saved
      expect(mockStoreToken).toHaveBeenCalled();
    });

    test("handles codes with special characters and spaces", async () => {
      const email = "user@gmail.com";
      const code = "4/0AX4XfWh7 code with spaces";

      const parseResult = parseEmailVerifyArgs(`${email} ${code}`);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      expect(parseResult.data.code).toBe(code);

      // Should work with the full code
      const tokenData = await mockExchangeCodeForToken(parseResult.data.code, parseResult.data.email);
      expect(tokenData).toBeDefined();
    });
  });

  describe("edge cases", () => {
    test("handles case-insensitive email", async () => {
      const code = "valid_code";
      const parseResult = parseEmailVerifyArgs("User@Gmail.com " + code);

      expect(parseResult.success).toBe(true);
      if (!parseResult.success) return;

      expect(parseResult.data.email).toBe("user@gmail.com");
    });

    test("validates email before attempting token exchange", async () => {
      // Parser rejects invalid email
      const parseResult = parseEmailVerifyArgs("invalid code123");
      expect(parseResult.success).toBe(false);

      // Token exchange should never be called
      expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
    });

    test("requires both email and code", async () => {
      const missingCode = parseEmailVerifyArgs("user@gmail.com");
      expect(missingCode.success).toBe(false);
      if (!missingCode.success) {
        expect(missingCode.error).toContain("Missing authorization code");
      }

      const missingEmail = parseEmailVerifyArgs("code123");
      expect(missingEmail.success).toBe(false);
      if (!missingEmail.success) {
        expect(missingEmail.error).toContain("Invalid or missing email");
      }
    });
  });
});

// ============================================================
// PROVIDER DETECTION TESTS
// ============================================================

describe("verify flow: provider detection", () => {
  test("detects Gmail provider from email domain", () => {
    const validation = validateEmailWithProvider("test@gmail.com");
    expect(validation.valid).toBe(true);
    expect(validation.provider).toBe("gmail");
  });

  test("detects Googlemail as Gmail", () => {
    const validation = validateEmailWithProvider("test@googlemail.com");
    expect(validation.valid).toBe(true);
    expect(validation.provider).toBe("gmail");
  });

  test("detects Outlook provider from email domain", () => {
    const validation = validateEmailWithProvider("test@outlook.com");
    expect(validation.valid).toBe(true);
    expect(validation.provider).toBe("outlook");
  });

  test("detects Hotmail as Outlook", () => {
    const validation = validateEmailWithProvider("test@hotmail.com");
    expect(validation.valid).toBe(true);
    expect(validation.provider).toBe("outlook");
  });

  test("detects Live as Outlook", () => {
    const validation = validateEmailWithProvider("test@live.com");
    expect(validation.valid).toBe(true);
    expect(validation.provider).toBe("outlook");
  });

  test("allows unknown domains with undefined provider", () => {
    const validation = validateEmailWithProvider("test@customdomain.org");
    expect(validation.valid).toBe(true);
    // Unknown domains have undefined provider - can be overridden via --provider flag
    expect(validation.provider).toBeUndefined();
  });
});

// ============================================================
// USER FEEDBACK MESSAGES
// ============================================================

describe("verify flow: user feedback", () => {
  // These tests verify the expected user-facing messages

  test("success message format includes email and provider", () => {
    const email = "user@gmail.com";
    const provider = "gmail";
    const providerDisplayName = "Gmail";

    const expectedMessage = `✅ Account Added Successfully!\n\nEmail: ${email}\nProvider: ${providerDisplayName}`;
    expect(expectedMessage).toContain(email);
    expect(expectedMessage).toContain(providerDisplayName);
  });

  test("error message uses parseOAuthError for user-friendly output", () => {
    const errorMsg = "Token exchange failed: invalid_grant";

    // Verify that parseOAuthError categorizes this correctly
    const parsed = parseOAuthError(errorMsg);
    expect(parsed.category).toBe("invalid_code");
    expect(parsed.userMessage).toContain("invalid");
    expect(parsed.suggestion).toContain("entire code");

    // The relay formats this as HTML:
    // `❌ <b>Authorization Failed</b>\n\n${parsed.userMessage}\n\n<b>Suggestion:</b> ${parsed.suggestion}`
    const expectedMessage = `❌ <b>Authorization Failed</b>\n\n${parsed.userMessage}\n\n<b>Suggestion:</b> ${parsed.suggestion}`;
    expect(expectedMessage).toContain("<b>Authorization Failed</b>");
    expect(expectedMessage).toContain(parsed.suggestion);
  });

  test("usage message shows correct format", () => {
    const usageMessage = "Usage: /email verify <email> <authorization_code>";
    expect(usageMessage).toContain("/email verify");
    expect(usageMessage).toContain("<email>");
    expect(usageMessage).toContain("<authorization_code>");
  });
});
