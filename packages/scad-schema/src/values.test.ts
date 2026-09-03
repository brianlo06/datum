import { describe, expect, it } from "vitest";
import { parseScad } from "./parse.js";
import { buildHash, hashSource, serializeValue, toArgs, validate } from "./values.js";

const SOURCE = [
  "/* [Fasteners] */",
  "// Bolt diameter",
  "bolt_d = 3; // [3:0.5:8]",
  "// Wall thickness",
  "wall = 2.4;",
  "/* [Features] */",
  "with_lid = true;",
  'material = "PETG"; // [PLA, PETG, ASA]',
  'name_tag = "front"; // 8',
  "size = [10, 20, 30]; // [1:100]",
].join("\n");

const schema = parseScad(SOURCE);

describe("serializeValue", () => {
  it("renders each literal type as OpenSCAD source", () => {
    expect(serializeValue(3)).toBe("3");
    expect(serializeValue(2.5)).toBe("2.5");
    expect(serializeValue(true)).toBe("true");
    expect(serializeValue(false)).toBe("false");
    expect(serializeValue("PETG")).toBe('"PETG"');
    expect(serializeValue([1, 2, 3])).toBe("[1,2,3]");
  });

  it("escapes quotes and backslashes so a string cannot break out of its literal", () => {
    expect(serializeValue('a"b')).toBe('"a\\"b"');
    expect(serializeValue("a\\b")).toBe('"a\\\\b"');
  });

  it("neutralises an attempt to inject an expression through a string value", () => {
    const hostile = '"; cube(999); x="';
    const out = serializeValue(hostile);
    // The payload survives only as inert text inside a single quoted literal:
    // every interior quote is escaped, so it cannot terminate the string early.
    expect(out).toBe('"\\"; cube(999); x=\\""');
    expect(out.slice(1, -1)).not.toMatch(/(?<!\\)"/);
  });

  it("refuses non-finite numbers", () => {
    expect(() => serializeValue(Number.NaN)).toThrow();
    expect(() => serializeValue(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("validate", () => {
  it("fills in defaults for everything not supplied", () => {
    const result = validate(schema, {});
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({
      bolt_d: 3,
      wall: 2.4,
      with_lid: true,
      material: "PETG",
      name_tag: "front",
      size: [10, 20, 30],
    });
  });

  it("accepts values inside the declared range", () => {
    const result = validate(schema, { bolt_d: 5, material: "ASA" });
    expect(result.ok).toBe(true);
    expect(result.values.bolt_d).toBe(5);
    expect(result.values.material).toBe("ASA");
  });

  it("rejects a value outside the slider range", () => {
    const result = validate(schema, { bolt_d: 20 });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ param: "bolt_d", message: "must be between 3 and 8" }]);
  });

  it("rejects a value outside a dropdown", () => {
    const result = validate(schema, { material: "Concrete" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain("must be one of");
  });

  it("rejects an over-long string", () => {
    const result = validate(schema, { name_tag: "far too long to fit" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toBe("must be at most 8 characters");
  });

  it("rejects an unknown parameter rather than silently ignoring it", () => {
    const result = validate(schema, { bolt_diameter: 4 });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toEqual({
      param: "bolt_diameter",
      message: "is not a parameter of this part",
    });
  });

  it("checks vector length and per-component range", () => {
    expect(validate(schema, { size: [1, 2] }).errors[0]!.message).toBe(
      "must have exactly 3 components",
    );
    expect(validate(schema, { size: [1, 2, 500] }).errors[0]!.message).toBe(
      "each component must be between 1 and 100",
    );
    expect(validate(schema, { size: [5, 6, 7] }).ok).toBe(true);
  });

  it("coerces the strings a form submits into numbers and booleans", () => {
    const result = validate(schema, { bolt_d: "4.5", with_lid: "false" });
    expect(result.ok).toBe(true);
    expect(result.values.bolt_d).toBe(4.5);
    expect(result.values.with_lid).toBe(false);
  });

  it("falls back to the default for an invalid value so a build can still be attempted", () => {
    const result = validate(schema, { bolt_d: "not a number" });
    expect(result.ok).toBe(false);
    expect(result.values.bolt_d).toBe(3);
  });
});

describe("toArgs", () => {
  it("emits one -D pair per parameter in schema order", () => {
    const { values } = validate(schema, { bolt_d: 4, material: "ASA" });
    expect(toArgs(schema, values)).toEqual([
      "-D", "bolt_d=4",
      "-D", "wall=2.4",
      "-D", "with_lid=true",
      "-D", 'material="ASA"',
      "-D", 'name_tag="front"',
      "-D", "size=[10,20,30]",
    ]);
  });
});

describe("buildHash", () => {
  const src = hashSource(SOURCE);

  it("is stable regardless of key order", () => {
    const a = buildHash(src, { b: 2, a: 1 });
    const b = buildHash(src, { a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("changes when a parameter changes", () => {
    expect(buildHash(src, { a: 1 })).not.toBe(buildHash(src, { a: 2 }));
  });

  it("changes when the source changes", () => {
    expect(buildHash(src, { a: 1 })).not.toBe(buildHash(hashSource(SOURCE + "\n"), { a: 1 }));
  });

  it("does not collide across differently-typed values that stringify alike", () => {
    expect(buildHash(src, { a: 1 })).not.toBe(buildHash(src, { a: "1" }));
  });

  it("changes when the build environment changes", () => {
    // Bumping a vendored library must invalidate cached geometry.
    expect(buildHash(src, { a: 1 }, "libs-v1")).not.toBe(buildHash(src, { a: 1 }, "libs-v2"));
  });

  it("is unchanged when no environment digest is supplied", () => {
    expect(buildHash(src, { a: 1 }, "")).toBe(buildHash(src, { a: 1 }));
  });

  it("does not let an environment digest be confused with a parameter value", () => {
    expect(buildHash(src, { a: 1 }, "x")).not.toBe(buildHash(src, { a: 1, " ": "x" }));
  });
});
