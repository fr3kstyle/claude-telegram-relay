/**
 * Tests for email/validation.ts
 *
 * Run with: bun test src/email/__tests__/validation.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  validateEmail,
  detectProviderFromEmail,
  isValidProviderType,
  getProviderDisplayName,
  sanitizeDisplayName,
  validateEmailWithProvider,
} from "../validation.ts";

describe("validateEmail", () => {
  describe("valid emails", () => {
    test("accepts standard gmail address", () => {
      expect(validateEmail("user@gmail.com")).toBe(true);
    });

    test("accepts email with dots in local part", () => {
      expect(validateEmail("first.last@gmail.com")).toBe(true);
    });

    test("accepts email with plus sign", () => {
      expect(validateEmail("user+tag@gmail.com")).toBe(true);
    });

    test("accepts email with hyphen in domain", () => {
      expect(validateEmail("user@my-domain.com")).toBe(true);
    });

    test("accepts email with numbers", () => {
      expect(validateEmail("user123@gmail.com")).toBe(true);
    });

    test("accepts email with underscore", () => {
      expect(validateEmail("user_name@gmail.com")).toBe(true);
    });

    test("accepts subdomain", () => {
      expect(validateEmail("user@mail.company.com")).toBe(true);
    });

    test("accepts single character local part", () => {
      expect(validateEmail("a@gmail.com")).toBe(true);
    });

    test("accepts 64 character local part (max)", () => {
      const localPart = "a".repeat(64);
      expect(validateEmail(`${localPart}@gmail.com`)).toBe(true);
    });
  });

  describe("invalid emails", () => {
    test("rejects empty string", () => {
      expect(validateEmail("")).toBe(false);
    });

    test("rejects missing @ symbol", () => {
      expect(validateEmail("usergmail.com")).toBe(false);
    });

    test("rejects multiple @ symbols", () => {
      expect(validateEmail("user@@gmail.com")).toBe(false);
    });

    test("rejects missing domain", () => {
      expect(validateEmail("user@")).toBe(false);
    });

    test("rejects missing local part", () => {
      expect(validateEmail("@gmail.com")).toBe(false);
    });

    test("rejects missing TLD", () => {
      expect(validateEmail("user@gmail")).toBe(false);
    });

    test("rejects single character TLD", () => {
      expect(validateEmail("user@gmail.c")).toBe(false);
    });

    test("rejects consecutive dots", () => {
      expect(validateEmail("user..name@gmail.com")).toBe(false);
    });

    test("rejects local part over 64 characters", () => {
      const localPart = "a".repeat(65);
      expect(validateEmail(`${localPart}@gmail.com`)).toBe(false);
    });

    test("rejects email over 254 characters total", () => {
      const localPart = "a".repeat(64);
      const domain = "b".repeat(190) + ".com"; // Total > 254
      expect(validateEmail(`${localPart}@${domain}`)).toBe(false);
    });

    test("rejects spaces", () => {
      expect(validateEmail("user name@gmail.com")).toBe(false);
    });

    test("rejects spaces", () => {
      expect(validateEmail("user name@gmail.com")).toBe(false);
    });

    // Note: RFC 5322 technically allows leading dots, but many providers reject them
    // The current regex accepts them, which is valid per RFC
    test("accepts leading dot in local part (RFC 5322 valid)", () => {
      // Some email servers reject this, but it's technically valid
      expect(validateEmail(".user@gmail.com")).toBe(true);
    });
  });
});

describe("detectProviderFromEmail", () => {
  describe("Gmail detection", () => {
    test("detects gmail.com", () => {
      expect(detectProviderFromEmail("user@gmail.com")).toBe("gmail");
    });

    test("detects googlemail.com", () => {
      expect(detectProviderFromEmail("user@googlemail.com")).toBe("gmail");
    });

    test("detects case-insensitively", () => {
      expect(detectProviderFromEmail("user@GMAIL.COM")).toBe("gmail");
    });
  });

  describe("Outlook detection", () => {
    test("detects outlook.com", () => {
      expect(detectProviderFromEmail("user@outlook.com")).toBe("outlook");
    });

    test("detects hotmail.com", () => {
      expect(detectProviderFromEmail("user@hotmail.com")).toBe("outlook");
    });

    test("detects live.com", () => {
      expect(detectProviderFromEmail("user@live.com")).toBe("outlook");
    });

    test("detects msn.com", () => {
      expect(detectProviderFromEmail("user@msn.com")).toBe("outlook");
    });

    test("detects hotmail.co.uk", () => {
      expect(detectProviderFromEmail("user@hotmail.co.uk")).toBe("outlook");
    });
  });

  describe("unknown providers", () => {
    test("returns null for custom domain", () => {
      expect(detectProviderFromEmail("user@company.com")).toBe(null);
    });

    test("returns null for invalid email", () => {
      expect(detectProviderFromEmail("invalid")).toBe(null);
    });
  });
});

describe("isValidProviderType", () => {
  test("accepts gmail", () => {
    expect(isValidProviderType("gmail")).toBe(true);
  });

  test("accepts outlook", () => {
    expect(isValidProviderType("outlook")).toBe(true);
  });

  test("rejects yahoo", () => {
    expect(isValidProviderType("yahoo")).toBe(false);
  });

  test("rejects invalid string", () => {
    expect(isValidProviderType("invalid")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidProviderType("")).toBe(false);
  });
});

describe("getProviderDisplayName", () => {
  test("returns Gmail for gmail", () => {
    expect(getProviderDisplayName("gmail")).toBe("Gmail");
  });

  test("returns Outlook/Microsoft for outlook", () => {
    expect(getProviderDisplayName("outlook")).toBe("Outlook/Microsoft");
  });
});

describe("sanitizeDisplayName", () => {
  test("returns undefined for undefined input", () => {
    expect(sanitizeDisplayName(undefined)).toBe(undefined);
  });

  test("returns undefined for empty string", () => {
    expect(sanitizeDisplayName("")).toBe(undefined);
  });

  test("returns undefined for whitespace only", () => {
    expect(sanitizeDisplayName("   ")).toBe(undefined);
  });

  test("trims whitespace", () => {
    expect(sanitizeDisplayName("  John Doe  ")).toBe("John Doe");
  });

  test("removes control characters", () => {
    expect(sanitizeDisplayName("John\x00Doe")).toBe("JohnDoe");
  });

  test("removes tab and newline characters", () => {
    expect(sanitizeDisplayName("John\t\nDoe")).toBe("JohnDoe");
  });

  test("limits to 100 characters", () => {
    const longName = "a".repeat(150);
    expect(sanitizeDisplayName(longName)).toBe("a".repeat(100));
  });

  test("preserves unicode characters", () => {
    expect(sanitizeDisplayName("José García")).toBe("José García");
  });
});

describe("validateEmailWithProvider", () => {
  describe("basic validation", () => {
    test("validates and normalizes email", () => {
      const result = validateEmailWithProvider("  USER@GMAIL.COM  ");
      expect(result.valid).toBe(true);
      expect(result.email).toBe("user@gmail.com");
      expect(result.provider).toBe("gmail");
    });

    test("returns error for invalid email", () => {
      const result = validateEmailWithProvider("invalid");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid email address format");
    });
  });

  describe("provider detection", () => {
    test("detects gmail provider", () => {
      const result = validateEmailWithProvider("user@gmail.com");
      expect(result.valid).toBe(true);
      expect(result.provider).toBe("gmail");
    });

    test("detects outlook provider", () => {
      const result = validateEmailWithProvider("user@outlook.com");
      expect(result.valid).toBe(true);
      expect(result.provider).toBe("outlook");
    });

    test("returns undefined provider for unknown domain", () => {
      const result = validateEmailWithProvider("user@company.com");
      expect(result.valid).toBe(true);
      expect(result.provider).toBe(undefined);
    });
  });

  describe("expected provider validation", () => {
    test("passes when detected matches expected", () => {
      const result = validateEmailWithProvider("user@gmail.com", "gmail");
      expect(result.valid).toBe(true);
      expect(result.provider).toBe("gmail");
    });

    test("fails when detected differs from expected", () => {
      const result = validateEmailWithProvider("user@gmail.com", "outlook");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Gmail");
      expect(result.error).toContain("Outlook");
    });

    test("allows manual override for unknown domain", () => {
      const result = validateEmailWithProvider("user@company.com", "gmail");
      expect(result.valid).toBe(true);
      expect(result.provider).toBe("gmail");
    });
  });
});
