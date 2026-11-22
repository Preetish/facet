import { describe, expect, it } from "vitest";
import { assignBucket, fnv1a32, generateVisitorId, hashToUnitInterval } from "../src/index.js";

describe("deterministic sticky bucketing", () => {
  it("computes standard FNV-1a 32-bit hashes", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("handles unicode input deterministically", () => {
    const first = fnv1a32("visitor-🚀:exp-1");
    const second = fnv1a32("visitor-🚀:exp-1");
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(0x100000000);
  });

  it("normalizes hashes strictly into [0, 1)", () => {
    for (let i = 0; i < 500; i++) {
      const value = hashToUnitInterval(`visitor-${i}`, "fintech-abm");
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("returns always variant for holdout <= 0 and always control for holdout >= 1", () => {
    for (let i = 0; i < 200; i++) {
      expect(assignBucket(`v-${i}`, "exp-a", 0)).toBe("variant");
      expect(assignBucket(`v-${i}`, "exp-a", -0.5)).toBe("variant");
      expect(assignBucket(`v-${i}`, "exp-a", Number.NaN)).toBe("variant");
      expect(assignBucket(`v-${i}`, "exp-a", 1)).toBe("control");
      expect(assignBucket(`v-${i}`, "exp-a", 1.5)).toBe("control");
    }
  });

  it("is sticky per (visitorId, experienceId) and roughly uniform across visitors", () => {
    const holdout = 0.2;
    let controlCount = 0;
    const total = 5000;

    for (let i = 0; i < total; i++) {
      const vid = `visitor-${i}`;
      const bucket1 = assignBucket(vid, "fintech-abm", holdout);
      const bucket2 = assignBucket(vid, "fintech-abm", holdout);
      expect(bucket1).toBe(bucket2);
      if (bucket1 === "control") {
        controlCount++;
      }
    }

    const ratio = controlCount / total;
    expect(ratio).toBeGreaterThan(0.17);
    expect(ratio).toBeLessThan(0.23);
  });

  it("hashes different experiences independently for the same visitor", () => {
    let differing = 0;
    for (let i = 0; i < 200; i++) {
      const vid = `visitor-${i}`;
      const b1 = assignBucket(vid, "exp-alpha", 0.5);
      const b2 = assignBucket(vid, "exp-beta", 0.5);
      if (b1 !== b2) differing++;
    }
    expect(differing).toBeGreaterThan(50);
  });

  it("generates unique UUID visitor IDs", () => {
    const id1 = generateVisitorId();
    const id2 = generateVisitorId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
