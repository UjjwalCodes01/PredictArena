/**
 * Profile validation.
 *
 * These run on the SERVER's normaliser, which is the only validation that
 * counts -- the browser form is a convenience, not a control.
 *
 * The URL cases are the important ones: a stored `javascript:` address becomes
 * clickable script the moment a profile renders it as a link.
 */
import { describe, it, expect } from "vitest";
import { normalizeProfile, BIO_MAX, DisplayNameError } from "../queries.js";

describe("display name", () => {
  it("accepts a normal handle and trims it", () => {
    expect(normalizeProfile({ displayName: "  satoshi  " }).displayName).toBe("satoshi");
  });
  it("clears the name when given an empty string", () => {
    expect(normalizeProfile({ displayName: "" }).displayName).toBeNull();
  });
  for (const bad of ["ab", "a".repeat(21), "has space", "bad!char", "emoji\u{1F600}"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => normalizeProfile({ displayName: bad })).toThrow(DisplayNameError);
    });
  }
});

describe("bio", () => {
  it("accepts and trims", () => {
    expect(normalizeProfile({ bio: "  calls the tops  " }).bio).toBe("calls the tops");
  });
  it("clears on empty", () => {
    expect(normalizeProfile({ bio: "   " }).bio).toBeNull();
  });
  it(`rejects over ${BIO_MAX} characters`, () => {
    expect(() => normalizeProfile({ bio: "x".repeat(BIO_MAX + 1) })).toThrow(DisplayNameError);
  });
  it("stores markup as literal text rather than rejecting it", () => {
    // React escapes on render; the danger is a URL scheme, not angle brackets.
    expect(normalizeProfile({ bio: "<b>hi</b>" }).bio).toBe("<b>hi</b>");
  });
});

describe("twitter handle", () => {
  const cases: Array<[string, string | null]> = [
    ["satoshi", "satoshi"],
    ["@satoshi", "satoshi"],
    ["https://x.com/satoshi", "satoshi"],
    ["https://twitter.com/satoshi", "satoshi"],
    ["https://www.x.com/satoshi/", "satoshi"],
    ["", null],
  ];
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} -> ${want}`, () => {
      expect(normalizeProfile({ twitter: input }).twitter).toBe(want);
    });
  }
  it("rejects something that is not a handle", () => {
    expect(() => normalizeProfile({ twitter: "not a handle!" })).toThrow(DisplayNameError);
  });
});

describe("website", () => {
  it("keeps an https URL", () => {
    expect(normalizeProfile({ website: "https://example.com/x" }).website).toBe("https://example.com/x");
  });
  it("assumes https when no scheme is given", () => {
    expect(normalizeProfile({ website: "example.com" }).website).toBe("https://example.com/");
  });
  it("allows plain http", () => {
    expect(normalizeProfile({ website: "http://example.com" }).website).toBe("http://example.com/");
  });

  // The whole reason this function exists.
  for (const attack of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com",
    "mailto:a@b.com",
  ]) {
    it(`REFUSES ${attack.slice(0, 28)}`, () => {
      expect(() => normalizeProfile({ website: attack })).toThrow(DisplayNameError);
    });
  }

  it("rejects an absurdly long URL", () => {
    expect(() => normalizeProfile({ website: `https://e.com/${"x".repeat(300)}` })).toThrow(DisplayNameError);
  });
  it("clears on empty", () => {
    expect(normalizeProfile({ website: "" }).website).toBeNull();
  });
});

describe("partial updates", () => {
  it("leaves untouched fields absent, so a save cannot blank them by omission", () => {
    const out = normalizeProfile({ bio: "hello" });
    expect(out.bio).toBe("hello");
    expect("displayName" in out).toBe(false);
    expect("website" in out).toBe(false);
  });
});
