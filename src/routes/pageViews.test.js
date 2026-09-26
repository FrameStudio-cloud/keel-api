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

  // Deliberately NOT filtered: a shop's production site may itself live on a
  // vercel.app domain (kikoi is kikoi-opal.vercel.app), so treating
  // *.vercel.app as Direct would throw away its real traffic. Preview deploys
  // are therefore attributed by hostname; test against the production URL.
  it("keeps a vercel.app host as a real source", () => {
    expect(sourceFromReferrer("https://kikoi-opal.vercel.app/shop")).toBe(
      "kikoi-opal.vercel.app"
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
