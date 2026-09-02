import { describe, expect, it } from "vitest";
import { diffSchemas, parseScad } from "@datum/scad-schema";
import {
  applyBump,
  checkChosenVersion,
  InvalidVersionError,
  isAfter,
  parseVersion,
  proposeBump,
  type GeometrySummary,
} from "./versioning.js";

const s = (...lines: string[]) => parseScad(lines.join("\n"));
const geo = (size: [number, number, number], volume: number, solid = true): GeometrySummary => ({
  boundingBox: { size },
  volumeMm3: volume,
  solid,
});

const SAME = s("w = 5; // [1:10]");

describe("version arithmetic", () => {
  it("parses and rejects", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(() => parseVersion("1.2")).toThrow(InvalidVersionError);
    expect(() => parseVersion("v1.2.3")).toThrow(InvalidVersionError);
  });

  it("bumps each level, resetting lower components", () => {
    expect(applyBump("1.4.7", "major")).toBe("2.0.0");
    expect(applyBump("1.4.7", "minor")).toBe("1.5.0");
    expect(applyBump("1.4.7", "patch")).toBe("1.4.8");
  });

  it("orders versions numerically, not lexically", () => {
    expect(isAfter("1.10.0", "1.9.0")).toBe(true);
    expect(isAfter("1.9.0", "1.10.0")).toBe(false);
    expect(isAfter("1.0.0", "1.0.0")).toBe(false);
    expect(isAfter("2.0.0", "1.99.99")).toBe(true);
  });
});

describe("proposeBump", () => {
  it("proposes a patch when nothing changed", () => {
    const p = proposeBump("1.0.0", diffSchemas(SAME, SAME), geo([40, 20, 40], 7454), geo([40, 20, 40], 7454));
    expect(p.bump).toBe("patch");
    expect(p.version).toBe("1.0.1");
    expect(p.reasons[0]!.message).toContain("No interface or geometry change");
  });

  it("proposes a major when a parameter is removed", () => {
    const p = proposeBump(
      "1.2.3",
      diffSchemas(s("w = 5;", "h = 2;"), s("w = 5;")),
      geo([40, 20, 40], 7454),
      geo([40, 20, 40], 7454),
    );
    expect(p.bump).toBe("major");
    expect(p.version).toBe("2.0.0");
    expect(p.reasons.some((r) => r.message.includes('"h" was removed'))).toBe(true);
  });

  it("proposes a minor when a parameter is added", () => {
    const p = proposeBump(
      "1.2.3",
      diffSchemas(s("w = 5;"), s("w = 5;", "fillet = 1;")),
      geo([40, 20, 40], 7454),
      geo([40, 20, 40], 7454),
    );
    expect(p.bump).toBe("minor");
    expect(p.version).toBe("1.3.0");
  });

  it("proposes a major when a range narrows", () => {
    const p = proposeBump(
      "1.0.0",
      diffSchemas(s("w = 5; // [1:10]"), s("w = 5; // [2:8]")),
      geo([40, 20, 40], 7454),
      geo([40, 20, 40], 7454),
    );
    expect(p.bump).toBe("major");
  });

  it("proposes a major when the envelope changed for the same inputs", () => {
    const p = proposeBump("1.0.0", diffSchemas(SAME, SAME), geo([40, 20, 40], 7454), geo([45, 20, 40], 8100));
    expect(p.bump).toBe("major");
    expect(p.reasons.some((r) => r.message.includes("envelope changed"))).toBe(true);
  });

  it("proposes a minor when only internal volume changed", () => {
    const p = proposeBump("1.0.0", diffSchemas(SAME, SAME), geo([40, 20, 40], 7454), geo([40, 20, 40], 7100));
    expect(p.bump).toBe("minor");
    expect(p.reasons.some((r) => r.message.includes("internal geometry changed"))).toBe(true);
  });

  it("ignores tessellation-level volume noise", () => {
    const p = proposeBump("1.0.0", diffSchemas(SAME, SAME), geo([40, 20, 40], 7454), geo([40, 20, 40], 7454.0001));
    expect(p.bump).toBe("patch");
  });

  it("refuses to draw geometric conclusions when a default moved", () => {
    const p = proposeBump(
      "1.0.0",
      diffSchemas(s("w = 5; // [1:10]"), s("w = 8; // [1:10]")),
      geo([40, 20, 40], 7454),
      geo([70, 20, 70], 13454),
    );
    // The default changed, so the two builds are different configurations; the
    // size difference is expected and must not be read as a breaking change.
    expect(p.bump).toBe("minor");
    expect(p.reasons.some((r) => r.message.includes("Geometry was not compared"))).toBe(true);
    expect(p.reasons.some((r) => r.message.includes("envelope changed"))).toBe(false);
  });

  it("treats losing solidity as a major regression", () => {
    const p = proposeBump(
      "1.0.0",
      diffSchemas(SAME, SAME),
      geo([40, 20, 40], 7454, true),
      geo([40, 20, 40], 7454, false),
    );
    expect(p.bump).toBe("major");
    expect(p.reasons.some((r) => r.message.includes("no longer a closed solid"))).toBe(true);
  });

  it("takes the most severe reason when several apply", () => {
    const p = proposeBump(
      "1.0.0",
      diffSchemas(s("w = 5; // [1:10]", "old = 1;"), s("w = 5; // [1:20]", "added = 2;")),
      geo([40, 20, 40], 7454),
      geo([40, 20, 40], 7454),
    );
    expect(p.bump).toBe("major"); // removal wins over the additive changes
    expect(p.reasons.length).toBeGreaterThan(2);
  });

  it("always carries the caveat about what it cannot see", () => {
    const p = proposeBump("1.0.0", diffSchemas(SAME, SAME), null, null);
    expect(p.caveat).toContain("B-rep");
    expect(p.caveat).toContain("mating feature");
  });

  it("copes with a missing previous build", () => {
    const p = proposeBump("1.0.0", diffSchemas(SAME, SAME), null, geo([40, 20, 40], 7454));
    expect(p.bump).toBe("patch");
  });
});

describe("checkChosenVersion", () => {
  const majorProposal = proposeBump(
    "1.0.0",
    diffSchemas(s("w = 5;", "h = 1;"), s("w = 5;")),
    null,
    null,
  );

  it("accepts the proposed version", () => {
    expect(checkChosenVersion("2.0.0", majorProposal)).toEqual({ ok: true });
  });

  it("accepts a larger bump than proposed", () => {
    const minor = proposeBump("1.0.0", diffSchemas(s("w = 5;"), s("w = 5;", "n = 1;")), null, null);
    expect(checkChosenVersion("2.0.0", minor)).toEqual({ ok: true });
  });

  it("rejects a smaller bump than the evidence requires, and explains why", () => {
    const result = checkChosenVersion("1.1.0", majorProposal);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.message).toContain("needs at least a major bump");
    expect(result.message).toContain("was removed");
  });

  it("rejects a version that is not after the current release", () => {
    const result = checkChosenVersion("1.0.0", majorProposal);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.message).toContain("not after the current release");
  });

  it("rejects a malformed version", () => {
    const result = checkChosenVersion("2.0", majorProposal);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.message).toContain("major.minor.patch");
  });
});
