import { describe, it, expect } from "vitest";
import { singleSiteId, attributedSiteId } from "./events.js";

/**
 * Site attribution, which health validation now depends on.
 *
 * The reason this is worth testing on its own: since 20261002 the health check
 * is per-site, so this decision decides which vocabulary a site is measured
 * against. Get it wrong in one direction and a shop's health is refused; get it
 * wrong in the other and one storefront's health lands on another's bars.
 *
 * The database side (is_health_resource per site, and the rejection reason) is
 * verified against the running API rather than mocked here — this repo has no
 * route-level harness, and a mocked test would only be asserting the mock.
 */
describe("singleSiteId", () => {
  const A = "2f9af0c3-a127-44e1-b942-3eb520656f6e";
  const B = "ae1848e7-c74d-47e1-8839-1ead320ae94c";

  it("attributes events when the shop owns exactly one active site", () => {
    expect(singleSiteId([{ id: A }])).toBe(A);
  });

  // A shop token cannot say which of two storefronts sent the event, so it is
  // left unattributed rather than picked. The health check then falls back to
  // the global registry instead of refusing wholesale.
  it("does not guess between several active sites", () => {
    expect(singleSiteId([{ id: A }, { id: B }])).toBeNull();
    expect(singleSiteId([{ id: A }, { id: B }, { id: A }])).toBeNull();
  });

  it("handles a shop with no active sites", () => {
    expect(singleSiteId([])).toBeNull();
    expect(singleSiteId(null)).toBeNull();
    expect(singleSiteId(undefined)).toBeNull();
  });

  // The query filters on active = true, so an inactive row must never reach here.
  // If it did, and it were the only row, its id would be attributed.
  it("returns the id rather than the row", () => {
    expect(singleSiteId([{ id: A, name: "kf", active: true }])).toBe(A);
    expect(singleSiteId([{ id: A }])).not.toBe(undefined);
  });
});

/**
 * Precedence, since 20261004. This is the change that lets one shop run two
 * storefronts: a token issued for a storefront names its own site, so kikoi and
 * PowerSec on the same shop each report their own health instead of both going
 * dark.
 */
describe("attributedSiteId", () => {
  const KIKOI = "2f9af0c3-a127-44e1-b942-3eb520656f6e";
  const POWERSEC = "8a1c0000-1111-2222-3333-444444444444";

  it("prefers the token's own site over the single-active-site lookup", () => {
    // The token is for PowerSec, but the lookup would return kikoi - the shop's
    // other storefront. The token must win, or PowerSec's health lands on kikoi's
    // dashboard and both appear broken.
    expect(attributedSiteId(POWERSEC, [{ id: KIKOI }])).toBe(POWERSEC);
  });

  it("prefers the token's site even when the shop has several active sites", () => {
    // Before per-site tokens this was the unattributable case: two active sites
    // meant no site_id at all, and both storefronts lost their health.
    expect(attributedSiteId(POWERSEC, [{ id: KIKOI }, { id: POWERSEC }])).toBe(
      POWERSEC
    );
  });

  it("falls back to the lookup for a shop-level token", () => {
    expect(attributedSiteId(null, [{ id: KIKOI }])).toBe(KIKOI);
  });

  it("leaves events unattributed rather than guessing", () => {
    // No token site and several active sites: guessing would put one storefront's
    // health on another, so it stays null.
    expect(attributedSiteId(null, [{ id: KIKOI }, { id: POWERSEC }])).toBeNull();
  });

  it("is not confused by an empty-string site id", () => {
    // "" is falsy, so it falls through to the lookup instead of stamping a blank
    // site_id onto real events.
    expect(attributedSiteId("", [{ id: KIKOI }])).toBe(KIKOI);
    expect(attributedSiteId("", null)).toBeNull();
  });

  it("never returns undefined", () => {
    expect(attributedSiteId(null, undefined)).toBeNull();
    expect(attributedSiteId(undefined, null)).toBeNull();
  });
});