/**
 * Tests for command-parser.ts
 *
 * Run with: bun test src/utils/__tests__/command-parser.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  tokenize,
  parseFlag,
  parseEmail,
  parseProvider,
  parseDisplayName,
  parseEmailAddArgs,
  parseEmailVerifyArgs,
  validateEmailFormat,
  detectProviderFromDomain,
  sanitizeDisplayName,
  isValidProviderType,
  detectCodeProvider,
  validateCodeForProvider,
  EMAIL_ADD_USAGE,
  EMAIL_VERIFY_USAGE,
} from "../command-parser.ts";

describe("tokenize", () => {
  test("splits simple space-separated tokens", () => {
    expect(tokenize("a b c")).toEqual(["a", "b", "c"]);
  });

  test("handles quoted strings", () => {
    expect(tokenize('--name "Display Name"')).toEqual(["--name", "Display Name"]);
  });

  test("handles single quotes", () => {
    expect(tokenize("--name 'Display Name'")).toEqual(["--name", "Display Name"]);
  });

  test("handles escaped quotes inside strings", () => {
    expect(tokenize('"say \\"hello\\""')).toEqual(['say "hello"']);
  });

  test("handles multiple spaces", () => {
    expect(tokenize("a   b    c")).toEqual(["a", "b", "c"]);
  });

  test("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("parseFlag", () => {
  test("parses boolean flag when followed by another flag", () => {
    const result = parseFlag(["--verbose", "--other"], "verbose");
    expect(result).not.toBeNull();
    expect(result?.value).toBe(true);
    expect(result?.remaining).toEqual(["--other"]);
  });

  test("parses boolean flag at end of array", () => {
    const result = parseFlag(["other", "--verbose"], "verbose");
    expect(result).not.toBeNull();
    expect(result?.value).toBe(true);
    expect(result?.remaining).toEqual(["other"]);
  });

  test("parses flag with value", () => {
    const result = parseFlag(["--name", "John", "other"], "name");
    expect(result).not.toBeNull();
    expect(result?.value).toBe("John");
    expect(result?.remaining).toEqual(["other"]);
  });

  test("parses --flag=value format", () => {
    const result = parseFlag(["--name=John", "other"], "name");
    expect(result).not.toBeNull();
    expect(result?.value).toBe("John");
    expect(result?.remaining).toEqual(["other"]);
  });

  test("returns null for missing flag", () => {
    expect(parseFlag(["--other"], "name")).toBeNull();
  });
});

describe("parseEmail", () => {
  test("extracts email from start of string", () => {
    const result = parseEmail("user@example.com remaining");
    expect(result).toEqual({
      email: "user@example.com",
      remaining: "remaining",
    });
  });

  test("handles email at end of string", () => {
    const result = parseEmail("user@example.com");
    expect(result).toEqual({
      email: "user@example.com",
      remaining: "",
    });
  });

  test("returns null for invalid input", () => {
    expect(parseEmail("not-an-email")).toBeNull();
    expect(parseEmail("")).toBeNull();
  });
});

describe("parseProvider", () => {
  test("parses gmail provider", () => {
    const result = parseProvider("gmail remaining");
    expect(result).toEqual({
      provider: "gmail",
      remaining: "remaining",
    });
  });

  test("parses outlook provider (case insensitive)", () => {
    const result = parseProvider("Outlook remaining");
    expect(result).toEqual({
      provider: "outlook",
      remaining: "remaining",
    });
  });

  test("returns null for no provider", () => {
    expect(parseProvider("something-else")).toBeNull();
  });
});

describe("parseDisplayName", () => {
  test('parses --name "value" format', () => {
    const result = parseDisplayName('--name "Work Account" remaining');
    expect(result).toEqual({
      name: "Work Account",
      remaining: "remaining",
    });
  });

  test("parses --name=value format", () => {
    const result = parseDisplayName("--name=Personal remaining");
    expect(result).toEqual({
      name: "Personal",
      remaining: "remaining",
    });
  });

  test("returns null when no --name flag", () => {
    expect(parseDisplayName("no name flag")).toBeNull();
  });
});

describe("validateEmailFormat", () => {
  test("accepts valid email addresses", () => {
    expect(validateEmailFormat("user@example.com")).toBe(true);
    expect(validateEmailFormat("user.name@example.com")).toBe(true);
    expect(validateEmailFormat("user+tag@example.com")).toBe(true);
    expect(validateEmailFormat("user@subdomain.example.com")).toBe(true);
  });

  test("rejects invalid email addresses", () => {
    expect(validateEmailFormat("")).toBe(false);
    expect(validateEmailFormat("not-an-email")).toBe(false);
    expect(validateEmailFormat("@example.com")).toBe(false);
    expect(validateEmailFormat("user@")).toBe(false);
    expect(validateEmailFormat("user@example")).toBe(false); // No TLD
    expect(validateEmailFormat("user@example.c")).toBe(false); // TLD too short
  });

  test("rejects too long emails", () => {
    const longEmail = "a".repeat(300) + "@example.com";
    expect(validateEmailFormat(longEmail)).toBe(false);
  });
});

describe("detectProviderFromDomain", () => {
  test("detects Gmail", () => {
    expect(detectProviderFromDomain("user@gmail.com")).toBe("gmail");
    expect(detectProviderFromDomain("user@googlemail.com")).toBe("gmail");
  });

  test("detects Outlook", () => {
    expect(detectProviderFromDomain("user@outlook.com")).toBe("outlook");
    expect(detectProviderFromDomain("user@hotmail.com")).toBe("outlook");
    expect(detectProviderFromDomain("user@live.com")).toBe("outlook");
  });

  test("returns null for unknown domains", () => {
    expect(detectProviderFromDomain("user@company.com")).toBeNull();
    expect(detectProviderFromDomain("user@example.org")).toBeNull();
  });
});

describe("sanitizeDisplayName", () => {
  test("returns undefined for empty input", () => {
    expect(sanitizeDisplayName(undefined)).toBeUndefined();
    expect(sanitizeDisplayName("")).toBeUndefined();
    expect(sanitizeDisplayName("   ")).toBeUndefined();
  });

  test("removes control characters", () => {
    expect(sanitizeDisplayName("Hello\x00World")).toBe("HelloWorld");
    expect(sanitizeDisplayName("Test\x1F")).toBe("Test");
  });

  test("trims whitespace", () => {
    expect(sanitizeDisplayName("  Hello  ")).toBe("Hello");
  });

  test("limits length to 100 characters", () => {
    const longName = "a".repeat(150);
    expect(sanitizeDisplayName(longName)?.length).toBe(100);
  });
});

describe("isValidProviderType", () => {
  test("accepts valid provider types", () => {
    expect(isValidProviderType("gmail")).toBe(true);
    expect(isValidProviderType("outlook")).toBe(true);
    expect(isValidProviderType("imap")).toBe(true);
    expect(isValidProviderType("smtp")).toBe(true);
  });

  test("rejects invalid provider types", () => {
    expect(isValidProviderType("yahoo")).toBe(false);
    expect(isValidProviderType("custom")).toBe(false);
  });
});

describe("parseEmailAddArgs", () => {
  describe("success cases", () => {
    test("parses email only", () => {
      const result = parseEmailAddArgs("user@gmail.com");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
        expect(result.data.provider).toBe("gmail"); // auto-detected
        expect(result.data.displayName).toBeUndefined();
      }
    });

    test("normalizes email to lowercase", () => {
      const result = parseEmailAddArgs("User@Gmail.com");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
      }
    });

    test("parses email with explicit provider", () => {
      const result = parseEmailAddArgs("user@company.com gmail");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@company.com");
        expect(result.data.provider).toBe("gmail");
      }
    });

    test("parses email with display name", () => {
      const result = parseEmailAddArgs('user@gmail.com --name "Work Account"');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
        expect(result.data.displayName).toBe("Work Account");
      }
    });

    test("parses all components", () => {
      const result = parseEmailAddArgs('user@outlook.com outlook --name "Personal"');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@outlook.com");
        expect(result.data.provider).toBe("outlook");
        expect(result.data.displayName).toBe("Personal");
      }
    });

    test("handles extra whitespace", () => {
      const result = parseEmailAddArgs('   user@gmail.com   gmail   --name   "Work"   ');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
        expect(result.data.provider).toBe("gmail");
        expect(result.data.displayName).toBe("Work");
      }
    });

    test("auto-detects provider from domain when not specified", () => {
      const result = parseEmailAddArgs("user@hotmail.com");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.provider).toBe("outlook");
      }
    });

    test("handles custom domain without provider (returns null)", () => {
      const result = parseEmailAddArgs("user@company.com");
      expect(result.success).toBe(true);
      if (result.success) {
        // Provider is null when not auto-detected (custom domain)
        // This is falsy which is the expected behavior
        expect(result.data.provider).toBeFalsy();
      }
    });
  });

  describe("error cases", () => {
    test("rejects empty input", () => {
      const result = parseEmailAddArgs("");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No arguments");
        expect(result.usage).toBe(EMAIL_ADD_USAGE);
      }
    });

    test("rejects whitespace-only input", () => {
      const result = parseEmailAddArgs("   ");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No arguments");
      }
    });

    test("rejects invalid email format", () => {
      const result = parseEmailAddArgs("not-an-email");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("email");
      }
    });

    test("rejects unknown flag", () => {
      const result = parseEmailAddArgs("user@gmail.com --unknown");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Unknown flag");
      }
    });
  });
});

describe("parseEmailVerifyArgs", () => {
  describe("success cases", () => {
    test("parses email and simple code", () => {
      const result = parseEmailVerifyArgs("user@gmail.com abc123");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
        expect(result.data.code).toBe("abc123");
      }
    });

    test("normalizes email to lowercase", () => {
      const result = parseEmailVerifyArgs("User@Gmail.com abc123");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
      }
    });

    test("handles codes with spaces", () => {
      const result = parseEmailVerifyArgs("user@gmail.com 4/0AX4XfWh example code");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
        expect(result.data.code).toBe("4/0AX4XfWh example code");
      }
    });

    test("handles long OAuth codes", () => {
      const longCode = "4/0AX4XfWh7lIqx-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
      const result = parseEmailVerifyArgs(`user@gmail.com ${longCode}`);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe(longCode);
      }
    });

    test("handles URL-encoded codes with special characters", () => {
      const result = parseEmailVerifyArgs("user@gmail.com 4%2F0AX4XfWh%3D%3D");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe("4%2F0AX4XfWh%3D%3D");
      }
    });

    test("handles codes with dots and hyphens", () => {
      const result = parseEmailVerifyArgs("user@gmail.com M.C507_BAY.123-456");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe("M.C507_BAY.123-456");
      }
    });

    test("handles outlook email", () => {
      const result = parseEmailVerifyArgs("user@outlook.com outlook-code-123");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@outlook.com");
        expect(result.data.code).toBe("outlook-code-123");
      }
    });

    test("handles extra leading/trailing whitespace", () => {
      const result = parseEmailVerifyArgs("   user@gmail.com   abc123   ");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@gmail.com");
        expect(result.data.code).toBe("abc123");
      }
    });
  });

  describe("error cases", () => {
    test("rejects empty input", () => {
      const result = parseEmailVerifyArgs("");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No arguments");
        expect(result.usage).toBe(EMAIL_VERIFY_USAGE);
      }
    });

    test("rejects whitespace-only input", () => {
      const result = parseEmailVerifyArgs("   ");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No arguments");
      }
    });

    test("rejects missing email", () => {
      const result = parseEmailVerifyArgs("not-an-email code123");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("email");
      }
    });

    test("rejects email without code", () => {
      const result = parseEmailVerifyArgs("user@gmail.com");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Missing authorization code");
      }
    });

    test("rejects email with only whitespace after it", () => {
      const result = parseEmailVerifyArgs("user@gmail.com   ");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Missing authorization code");
      }
    });

    test("rejects invalid email format", () => {
      const result = parseEmailVerifyArgs("@gmail.com code123");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid");
      }
    });
  });
});

describe("detectCodeProvider", () => {
  describe("Google OAuth codes", () => {
    test("detects standard Google OAuth code", () => {
      const result = detectCodeProvider("4/0AX4XfWh7lIqx-abc123def456ghi789jkl");
      expect(result.provider).toBe("google");
      expect(result.isValid).toBe(true);
      expect(result.description).toContain("Google");
    });

    test("detects Google code starting with 4/", () => {
      const result = detectCodeProvider("4/something");
      expect(result.provider).toBe("google");
    });

    test("detects Google code with slashes and special chars", () => {
      const result = detectCodeProvider("4/0AX4XfWh/Test_Code-123");
      expect(result.provider).toBe("google");
    });
  });

  describe("Microsoft OAuth codes", () => {
    test("detects standard Microsoft OAuth code", () => {
      const result = detectCodeProvider("M.C507_BAY.123-456-abc");
      expect(result.provider).toBe("microsoft");
      expect(result.isValid).toBe(true);
      expect(result.description).toContain("Microsoft");
    });

    test("detects Microsoft code starting with M.", () => {
      const result = detectCodeProvider("M.something123");
      expect(result.provider).toBe("microsoft");
    });

    test("detects Microsoft code with region identifier", () => {
      const result = detectCodeProvider("M.C507_SN1.ABC-xyz");
      expect(result.provider).toBe("microsoft");
    });
  });

  describe("unknown formats", () => {
    test("returns unknown for empty code", () => {
      const result = detectCodeProvider("");
      expect(result.provider).toBe("unknown");
      expect(result.isValid).toBe(false);
    });

    test("returns unknown for whitespace", () => {
      const result = detectCodeProvider("   ");
      expect(result.provider).toBe("unknown");
    });

    test("returns unknown for unrecognized format", () => {
      const result = detectCodeProvider("random-code-xyz123");
      expect(result.provider).toBe("unknown");
    });

    test("accepts unknown format if long enough", () => {
      const result = detectCodeProvider("randomcodexyz12345678");
      expect(result.provider).toBe("unknown");
      expect(result.isValid).toBe(true);
    });

    test("rejects unknown format if too short", () => {
      const result = detectCodeProvider("short");
      expect(result.provider).toBe("unknown");
      expect(result.isValid).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("handles trimmed input", () => {
      const result = detectCodeProvider("  4/0AX4XfWh  ");
      expect(result.provider).toBe("google");
    });

    test("too-short Google code is invalid", () => {
      const result = detectCodeProvider("4/short");
      expect(result.provider).toBe("google");
      expect(result.isValid).toBe(false);
    });

    test("too-short Microsoft code is invalid", () => {
      const result = detectCodeProvider("M.short");
      expect(result.provider).toBe("microsoft");
      expect(result.isValid).toBe(false);
    });
  });
});

describe("validateCodeForProvider", () => {
  describe("matching code and provider", () => {
    test("accepts Google code with Gmail provider", () => {
      const error = validateCodeForProvider("4/0AX4XfWh7lIqx-abc123", "gmail");
      expect(error).toBeNull();
    });

    test("accepts Microsoft code with Outlook provider", () => {
      const error = validateCodeForProvider("M.C507_BAY.123-456-abc-def-ghi-jkl", "outlook");
      expect(error).toBeNull();
    });

    test("accepts unknown code format with any provider", () => {
      const error = validateCodeForProvider("some-random-code", "gmail");
      expect(error).toBeNull();
    });
  });

  describe("mismatch detection", () => {
    test("rejects Microsoft code with Gmail provider", () => {
      const error = validateCodeForProvider("M.C507_BAY.123-456", "gmail");
      expect(error).not.toBeNull();
      expect(error).toContain("Microsoft");
      expect(error).toContain("Gmail");
    });

    test("rejects Google code with Outlook provider", () => {
      const error = validateCodeForProvider("4/0AX4XfWh7lIqx", "outlook");
      expect(error).not.toBeNull();
      expect(error).toContain("Google");
      expect(error).toContain("Outlook");
    });
  });

  describe("incomplete codes", () => {
    test("warns about incomplete Google code", () => {
      const error = validateCodeForProvider("4/short", "gmail");
      expect(error).not.toBeNull();
      expect(error).toContain("incomplete");
    });

    test("warns about incomplete Microsoft code", () => {
      const error = validateCodeForProvider("M.short", "outlook");
      expect(error).not.toBeNull();
      expect(error).toContain("incomplete");
    });
  });

  describe("other providers", () => {
    test("accepts any code for IMAP provider", () => {
      const error = validateCodeForProvider("anything", "imap");
      expect(error).toBeNull();
    });

    test("accepts any code for SMTP provider", () => {
      const error = validateCodeForProvider("anything", "smtp");
      expect(error).toBeNull();
    });
  });
});

describe("parseEmailVerifyArgs with code validation", () => {
  describe("with validateCodeFormat enabled", () => {
    test("accepts matching code and provider", () => {
      const result = parseEmailVerifyArgs(
        "user@gmail.com 4/0AX4XfWh7lIqx-abc123def456",
        { validateCodeFormat: true }
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.codeProvider).toBe("google");
      }
    });

    test("rejects mismatched code and provider", () => {
      const result = parseEmailVerifyArgs(
        "user@gmail.com M.C507_BAY.123-456",
        { validateCodeFormat: true }
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Microsoft");
        expect(result.error).toContain("Gmail");
      }
    });

    test("accepts unknown code format", () => {
      const result = parseEmailVerifyArgs(
        "user@gmail.com custom-code-xyz",
        { validateCodeFormat: true }
      );
      expect(result.success).toBe(true);
    });
  });

  describe("codeProvider detection (always on)", () => {
    test("includes codeProvider in successful result", () => {
      const result = parseEmailVerifyArgs("user@gmail.com 4/0AX4XfWh");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.codeProvider).toBe("google");
      }
    });

    test("detects Microsoft code provider", () => {
      const result = parseEmailVerifyArgs("user@outlook.com M.C507_BAY.123");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.codeProvider).toBe("microsoft");
      }
    });
  });
});
