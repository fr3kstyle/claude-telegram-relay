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
  validateEmailFormat,
  detectProviderFromDomain,
  sanitizeDisplayName,
  isValidProviderType,
  EMAIL_ADD_USAGE,
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
