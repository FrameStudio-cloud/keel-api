import { describe, it, expect } from "vitest";
import { identityId } from "./identity.js";

const V4 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("identityId", () => {
  it("accepts a v4 uuid unchanged", () => {
    expect(identityId(V4)).toBe(V4);
  });

  it("lowercases and trims, so casing cannot create two visitors", () => {
    expect(identityId("  3F2504E0-4F89-41D3-9A0C-0305E82C3301 ")).toBe(V4);
  });

  // The rule that matters: a malformed id costs the identity, never the event.
  // Rejecting it in the schema would drop the whole event silently, including
  // the health report that says the shop is broken.
  it("nulls a malformed id instead of throwing", () => {
    for (const bad of [
      "not-a-uuid",
      "",
      "   ",
      "12345",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301-extra",
      "../../etc/passwd",
      "; DROP TABLE site_events; --",
      "3f2504e04f8941d39a0c0305e82c3301",
    ]) {
      expect(identityId(bad), bad).toBeNull();
    }
  });

  it("nulls anything that is not a string", () => {
    for (const bad of [null, undefined, 42, {}, [], true, { id: V4 }]) {
      expect(identityId(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  // A v1 uuid has a different version nibble. Nothing in the system generates
  // one, so accepting it would only widen the surface.
  it("rejects a non-v4 uuid", () => {
    expect(identityId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBeNull();
    expect(identityId("3f2504e0-4f89-41d3-5a0c-0305e82c3301")).toBeNull();
  });

  // The column is uuid, so an oversized value would be a 22P02 on the insert
  // and take the whole batch with it.
  it("truncates before testing, so length cannot reach the column", () => {
    const padded = V4 + "z".repeat(5000);
    expect(identityId(padded)).toBeNull();
  });

  // The reason truncation is not the implementation. Slicing to 36 and testing
  // would accept a valid uuid with anything appended, which is prefix-match
  // truncation: two different inputs silently become one visitor.
  it("does not accept a uuid with a smuggled suffix", () => {
    expect(identityId(V4 + "x")).toBeNull();
    expect(identityId(V4.slice(0, 35) + "x")).toBeNull();
  });
});
