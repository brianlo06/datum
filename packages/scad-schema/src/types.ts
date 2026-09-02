/**
 * The typed parameter schema Datum extracts from OpenSCAD source.
 *
 * OpenSCAD's Customizer already defines an annotation syntax in comments. Rather
 * than invent a manifest format and ask authors to duplicate what they've written,
 * we read theirs. An author whose part already works in the OpenSCAD GUI gets a
 * Datum configurator for free -- which is the entire "publishing is a side effect"
 * bet from the product brief.
 */

export type ParamType = "number" | "boolean" | "string" | "vector";

/** How the configurator should render a parameter. */
export type Widget =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "spinbox" }
  | { kind: "checkbox" }
  | { kind: "text"; maxLength?: number }
  | { kind: "select"; options: SelectOption[] }
  | { kind: "vector"; length: number; min?: number; max?: number; step?: number };

export interface SelectOption {
  /** The value substituted into the build. */
  value: number | string;
  /** Human label; falls back to String(value) when the author gave no label. */
  label: string;
}

export type ParamValue = number | boolean | string | number[];

export interface Param {
  name: string;
  type: ParamType;
  /** Default taken from the source assignment. */
  default: ParamValue;
  /** The raw right-hand side, kept for round-tripping and diagnostics. */
  raw: string;
  /** Customizer group, from `/* [Group] *\/` markers. Defaults to "Parameters". */
  group: string;
  /** Description from the comment line(s) immediately above the assignment. */
  description?: string;
  widget: Widget;
  /** 1-indexed line in the source file. */
  line: number;
}

export interface ParseWarning {
  line: number;
  message: string;
}

export interface ScadSchema {
  params: Param[];
  /** Group names in source order. */
  groups: string[];
  /** Params after a `/* [Hidden] *\/` marker: still assignable, never rendered. */
  hidden: string[];
  warnings: ParseWarning[];
}

export interface ValidationError {
  param: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** Full parameter set: supplied values coerced, plus defaults for the rest. */
  values: Record<string, ParamValue>;
}
