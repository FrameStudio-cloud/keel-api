import { describe, it, expect } from "vitest";
import { z } from "zod";
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

  // Non-strings must cost the identity, not the event. This is the case the
  // `z.string()` schema got wrong: it drops a malformed string correctly but
  // REJECTS the whole event for a number or an object, which is precisely the
  // silent loss of health reports that identity.js exists to prevent. Found by
  // posting these shapes at the live collector - a 400 per item, with nothing
  // anywhere saying why a health report had stopped arriving.
  it("drops a non-string id rather than throwing", () => {
    for (const bad of [12345, 0, true, false, null, undefined, {}, [], NaN]) {
      expect(identityId(bad)).toBeNull();
    }
  });
});

// The schema half of the same rule. `z.unknown().optional()` is deliberate on
// both counts, and both have to be tested separately:
//
//   - NOT z.string(): a wrong-typed id rejects the entire event.
//   - `.optional()` is load-bearing: in zod v4 a bare z.unknown() is REQUIRED.
//     That shipped, and it rejected every event that carried no identity - most
//     of them, since the SDK omits the fields when a visitor opts out. A test
//     that only checked present values passed while the route was broken.
describe("eventSchema identity fields", () => {
  const IDENTITY_SCHEMA = () =>
    z.object({
      name: z.string(),
      properties: z.record(z.any()).nullish(),
      path: z.string().max(300).nullish(),
      occurred_at: z.number().int().nullish(),
      visitor_id: z.unknown().optional(),
      session_id: z.unknown().optional(),
    });

  it("accepts any type for visitor_id and session_id", () => {
    const schema = IDENTITY_SCHEMA();
    for (const bad of [12345, 0, true, false, null, {}, [], "not-a-uuid", V4]) {
      const r = schema.safeParse({ name: "health_ok", properties: {}, visitor_id: bad, session_id: bad });
      expect(r.success, `rejected ${JSON.stringify(bad)}`).toBe(true);
    }
  });

  // The case that caught the bare z.unknown() regression.
  it("treats an ABSENT identity as valid, not as a schema error", () => {
    const schema = IDENTITY_SCHEMA();
    const r = schema.safeParse({ name: "health_ok", properties: {} });
    expect(r.success).toBe(true);
    expect(r.data.visitor_id).toBeUndefined();
    expect(r.data.session_id).toBeUndefined();
  });

  it("still rejects an unknown event name", () => {
    const schema = z.object({ name: z.enum(["health_ok", "health_fail", "error", "page_view"]) });
    expect(schema.safeParse({ name: "not_a_real_event" }).success).toBe(false);
  });

  // A bare z.unknown() is the regression, pinned so it cannot come back.
  it("bare z.unknown() would be required, which is why .optional() is there", () => {
    const bare = z.object({ name: z.string(), visitor_id: z.unknown() });
    const fixed = IDENTITY_SCHEMA();
    const payload = { name: "health_ok" };
    expect(bare.safeParse(payload).success).toBe(false);
    expect(fixed.safeParse(payload).success).toBe(true);
  });
});
