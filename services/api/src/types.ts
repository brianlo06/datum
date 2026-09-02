/** The subset of the builder's mesh metrics the API reasons about. */
export interface MeshMetricsLike {
  triangleCount: number;
  boundingBox: { size: [number, number, number] };
  volumeMm3: number;
  solid: boolean;
  openEdgeCount: number;
  nonManifoldEdgeCount: number;
}

/** A structured build diagnostic, as produced by the builder. */
export interface Diagnostic {
  level: "error" | "warning" | "info";
  raw: string;
  explanation?: string;
  hint?: string;
  file?: string;
  line?: number;
}
