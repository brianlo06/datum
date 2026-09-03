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

export interface PartSummary {
  handle: string;
  slug: string;
  title: string;
  summary: string;
  license: string;
  latest_version: string | null;
  updated_at: string;
  interfaces: { slug: string; name: string; role: "implements" | "consumes" }[];
}

export interface License {
  id: string;
  name: string;
  url: string;
  summary: string;
  commercialUse: boolean;
  derivatives: "yes" | "share-alike" | "no";
  recommended?: boolean;
}

export interface Interface {
  slug: string;
  name: string;
  description: string;
  implementors: string;
  consumers: string;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  blocking: boolean;
}

export interface Readiness {
  checks: ReadinessCheck[];
  ready: boolean;
  blockers: string[];
}

export interface PreflightBuild {
  ok: boolean;
  summary: string;
  diagnostics: Diagnostic[];
  metrics: Metrics | null;
  durationMs: number;
  previewBase64: string | null;
}

export interface Preflight {
  schema: ScadSchema;
  sourceHash: string;
  build: PreflightBuild;
  readiness: Readiness;
}

export interface PublishedPart {
  owner: string;
  slug: string;
  version: string;
  url: string;
  buildHash: string;
}

export interface BumpProposal {
  bump: "major" | "minor" | "patch";
  version: string;
  previousVersion: string;
  reasons: { level: "major" | "minor" | "patch"; message: string }[];
  caveat: string;
  minimum: string;
}

export interface ProposeResult {
  proposal: BumpProposal;
  readiness: Readiness;
  schema: ScadSchema;
  build: PreflightBuild;
  unchanged: boolean;
}

export interface InterfaceClaim {
  slug: string;
  role: "implements" | "consumes";
}

export interface VendoredLibrary {
  name: string;
  version: string;
  license: string;
  include: string;
}
