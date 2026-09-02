import { createHash } from "node:crypto";
import type { Param, ParamValue, ScadSchema, ValidationError, ValidationResult } from "./types.js";

/**
 * Render a value as an OpenSCAD literal.
 *
 * Everything reaching the build command goes through here. Values are re-emitted
 * from typed data rather than passed through as text, so a string parameter cannot
 * smuggle an expression (or a second `-D`) into the build. Parameter *names* are
 * never user-supplied -- they come from the parsed source -- so the pair is safe
 * by construction.
 */
export function serializeValue(value: ParamValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number cannot be serialized");
    return String(value);
  }
  if (typeof value === "string") {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((n) => serializeValue(n)).join(",")}]`;
  }
  throw new Error(`Unsupported parameter value: ${String(value)}`);
}

/** Build the `-D name=value` argument list for a validated parameter set. */
export function toArgs(schema: ScadSchema, values: Record<string, ParamValue>): string[] {
  const args: string[] = [];
  for (const param of schema.params) {
    const value = values[param.name];
    if (value === undefined) continue;
    args.push("-D", `${param.name}=${serializeValue(value)}`);
  }
  return args;
}

function coerce(param: Param, input: unknown, errors: ValidationError[]): ParamValue | undefined {
  const fail = (message: string) => {
    errors.push({ param: param.name, message });
    return undefined;
  };

  switch (param.type) {
    case "number": {
      const n = typeof input === "string" && input.trim() !== "" ? Number(input) : input;
      if (typeof n !== "number" || !Number.isFinite(n)) return fail("must be a finite number");
      if (param.widget.kind === "slider") {
        const { min, max } = param.widget;
        if (n < min || n > max) return fail(`must be between ${min} and ${max}`);
      }
      if (param.widget.kind === "select") {
        const allowed = param.widget.options.map((o) => o.value);
        if (!allowed.includes(n)) return fail(`must be one of: ${allowed.join(", ")}`);
      }
      return n;
    }
    case "boolean": {
      if (typeof input === "boolean") return input;
      if (input === "true") return true;
      if (input === "false") return false;
      return fail("must be true or false");
    }
    case "string": {
      if (typeof input !== "string") return fail("must be a string");
      if (param.widget.kind === "text" && param.widget.maxLength !== undefined) {
        if (input.length > param.widget.maxLength) {
          return fail(`must be at most ${param.widget.maxLength} characters`);
        }
      }
      if (param.widget.kind === "select") {
        const allowed = param.widget.options.map((o) => String(o.value));
        if (!allowed.includes(input)) return fail(`must be one of: ${allowed.join(", ")}`);
      }
      return input;
    }
    case "vector": {
      if (!Array.isArray(input)) return fail("must be an array of numbers");
      const nums: number[] = [];
      for (const raw of input) {
        const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
        if (typeof n !== "number" || !Number.isFinite(n)) {
          return fail("must contain only finite numbers");
        }
        nums.push(n);
      }
      if (param.widget.kind === "vector") {
        const w = param.widget;
        if (w.length > 0 && nums.length !== w.length) {
          return fail(`must have exactly ${w.length} components`);
        }
        if (w.min !== undefined && w.max !== undefined) {
          const lo = w.min;
          const hi = w.max;
          if (nums.some((n) => n < lo || n > hi)) {
            return fail(`each component must be between ${lo} and ${hi}`);
          }
        }
      }
      return nums;
    }
  }
}

/**
 * Validate a partial parameter set against a schema.
 *
 * Unknown keys are rejected rather than ignored: a typo'd parameter name would
 * otherwise silently produce the default part, which is exactly the kind of
 * quiet wrongness this platform exists to eliminate.
 */
export function validate(schema: ScadSchema, input: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const values: Record<string, ParamValue> = {};
  const known = new Map(schema.params.map((p) => [p.name, p] as const));

  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push({ param: key, message: "is not a parameter of this part" });
  }

  for (const param of schema.params) {
    const supplied = input[param.name];
    if (supplied === undefined || supplied === null) {
      values[param.name] = param.default;
      continue;
    }
    const coerced = coerce(param, supplied, errors);
    values[param.name] = coerced === undefined ? param.default : coerced;
  }

  return { ok: errors.length === 0, errors, values };
}

/**
 * A stable fingerprint of (source, parameters). Two builds with the same hash
 * must produce the same geometry, which is what makes the artifact cache and
 * the "has anyone built exactly this?" lookup possible.
 */
export function buildHash(sourceHash: string, values: Record<string, ParamValue>): string {
  const canonical = Object.keys(values)
    .sort()
    .map((k) => `${k}=${serializeValue(values[k]!)}`)
    .join(";");
  return createHash("sha256").update(`${sourceHash} ${canonical}`).digest("hex");
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
