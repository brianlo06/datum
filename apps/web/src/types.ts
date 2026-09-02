export type ParamValue = number | boolean | string | number[];

export type Widget =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "spinbox" }
  | { kind: "checkbox" }
  | { kind: "text"; maxLength?: number }
  | { kind: "select"; options: { value: number | string; label: string }[] }
  | { kind: "vector"; length: number; min?: number; max?: number; step?: number };

export interface Param {
  name: string;
  type: "number" | "boolean" | "string" | "vector";
  default: ParamValue;
  group: string;
  description?: string;
  widget: Widget;
  line: number;
}

export interface ScadSchema {
  params: Param[];
  groups: string[];
  hidden: string[];
  warnings: { line: number; message: string }[];
}

export interface Metrics {
  triangleCount: number;
  vertexCount: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  volumeMm3: number;
  surfaceAreaMm2: number;
  watertight: boolean;
  openEdgeCount: number;
  nonManifoldEdgeCount: number;
  degenerateTriangleCount: number;
  solid: boolean;
}

export interface Diagnostic {
  level: "error" | "warning" | "info";
  raw: string;
  explanation?: string;
  hint?: string;
  line?: number;
}

export interface BuildResult {
  buildHash: string;
  ok: boolean;
  cached: boolean;
  summary: string;
  diagnostics: Diagnostic[];
  metrics: Metrics | null;
  durationMs: number;
  params: Record<string, ParamValue>;
  configured: boolean;
  stlUrl: string | null;
  previewUrl: string | null;
}

export interface PartDetail {
  owner: string;
  slug: string;
  title: string;
  summary: string;
  license: string;
  version: string;
  versions: { version: string; notes: string; created_at: string }[];
  schema: ScadSchema;
  interfaces: { slug: string; name: string; description: string; role: "implements" | "consumes" }[];
  made: { machine: string; material: string; fitted: boolean; notes: string; created_at: string }[];
  source: string;
}

export interface ValidationFailure {
  error: string;
  errors: { param: string; message: string }[];
}
