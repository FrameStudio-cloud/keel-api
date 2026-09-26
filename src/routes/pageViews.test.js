import { describe, it, expect } from "vitest";
import { sourceFromReferrer } from "./pageViews.js";

describe("sourceFromReferrer", () => {
  it("maps known hosts to stable Title Case labels", () => {
    const cases = [
      ["https://www.google.com/search?q=shoes", "Google"],
      ["https://google.co.ke/", "Google"],
      ["https://www.facebook.com/", "Facebook"],
      ["https://l.facebook.com/l.php?u=x", "Facebook"],
      ["https://www.instagram.com/kikoiexpert", "Instagram"],
      ["https://t.co/abc", "X"],
      ["https://x.com/someone", "X"],
      ["https://wa.me/254700000000", "WhatsApp"],
      ["https://www.tiktok.com/@shop", "TikTok"],
    ];
    for (const [input, expected] of cases) {
      expect(sourceFromReferrer(input)).toBe(expected);
    }
  });

  it("treats an empty or missing referrer as Direct", () => {
    expect(sourceFromReferrer("")).toBe("Direct");
    expect(sourceFromReferrer(null)).toBe("Direct");
    expect(sourceFromReferrer(undefined)).toBe("Direct");
  });

  // A Vercel preview or a local dev server must not become its own "source",
  // otherwise it dilutes the real traffic numbers.
  it("treats local hosts as Direct", () => {
    for (const host of [
      "http://localhost:4599/",
      "http://127.0.0.1:3000/",
      "http://my-mac.local/",
      "http://app.localhost/",
    ]) {
      expect(sourceFromReferrer(host)).toBe("Direct");
    }
  });

  // Real bug seen in live data: browsing your own catalogue made the shop's own
  // domain the reported "traffic source", because document.referrer on an
  // internal hop is the previous page of the same site.
  it("treats internal navigation as Direct", () => {
    expect(
      sourceFromReferrer("https://kikoi-opal.vercel.app/shop", "https://kikoi-opal.vercel.app")
    ).toBe("Direct");
    expect(
      sourceFromReferrer("https://shop.example.com/a", "https://shop.example.com")
    ).toBe("Direct");
  });

  it("still attributes genuine external traffic on the same site", () => {
    expect(
      sourceFromReferrer("https://www.google.com/search?q=x", "https://kikoi-opal.vercel.app")
    ).toBe("Google");
    expect(
      sourceFromReferrer("https://l.facebook.com/l.php", "https://kikoi-opal.vercel.app")
    ).toBe("Facebook");
  });

  it("ignores a port and www prefix when comparing hosts", () => {
    expect(
      sourceFromReferrer("https://www.example.com:443/x", "https://example.com")
    ).toBe("Direct");
  });

  // Deliberately NOT filtered by suffix: a shop's production site may itself
  // live on a vercel.app domain (kikoi is kikoi-opal.vercel.app), so that would
  // throw away its real traffic. Preview deploys are therefore attributed by
  // hostname; test analytics against the production URL.
  it("keeps a vercel.app host as a real source when it is genuinely external", () => {
    expect(sourceFromReferrer("https://other-shop.vercel.app/shop")).toBe(
      "other-shop.vercel.app"
    );
  });

  it("accepts a bare host with no scheme", () => {
    expect(sourceFromReferrer("google.com")).toBe("Google");
    expect(sourceFromReferrer("www.instagram.com")).toBe("Instagram");
  });

  it("keeps an unknown but real host as the bare host", () => {
    expect(sourceFromReferrer("https://news.example.org/story")).toBe("news.example.org");
  });

  it("caps the returned host length", () => {
    const long = `https://${"a".repeat(200)}.com/`;
    expect(sourceFromReferrer(long).length).toBeLessThanOrEqual(40);
  });
});
