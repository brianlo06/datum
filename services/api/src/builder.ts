import type { Diagnostic } from "./types.js";
import type { MeshMetricsLike } from "./types.js";

const BUILDER_URL = process.env.BUILDER_URL ?? "http://localhost:8081";

export interface BuilderResponse {
  ok: boolean;
  summary: string;
  diagnostics: Diagnostic[];
  metrics: (MeshMetricsLike & Record<string, unknown>) | null;
  durationMs: number;
  timedOut: boolean;
  artifacts: { stl: string | null; png: string | null };
}

export class BuilderUnavailable extends Error {}
export class BuilderBusy extends Error {}

export interface BuildRequest {
  source: string;
  args: string[];
  files?: Record<string, string>;
  renderPreview?: boolean;
}

/** Call the sandboxed build service. The only place the API talks to it. */
export async function runBuild(request: BuildRequest): Promise<BuilderResponse> {
  let res: Response;
  try {
    res = await fetch(`${BUILDER_URL}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: request.source,
        args: request.args,
        ...(request.files ? { files: request.files } : {}),
        renderPreview: request.renderPreview === true,
      }),
    });
  } catch (err) {
    throw new BuilderUnavailable((err as Error).message);
  }

  if (res.status === 503) throw new BuilderBusy("all builders are busy");
  if (!res.ok && res.status >= 500) throw new BuilderUnavailable(`builder returned ${res.status}`);

  return (await res.json()) as BuilderResponse;
}

export async function builderHealth(): Promise<unknown> {
  try {
    return await (await fetch(`${BUILDER_URL}/health`)).json();
  } catch {
    return { ok: false, error: "unreachable" };
  }
}
