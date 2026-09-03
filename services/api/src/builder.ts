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

export async function builderHealth(): Promise<Record<string, unknown>> {
  try {
    return (await (await fetch(`${BUILDER_URL}/health`)).json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

/**
 * A digest identifying the build environment, folded into every build hash.
 *
 * Geometry depends on the sandbox's vendored library set as well as on the
 * source and parameters, so the cache key has to include it -- otherwise
 * bumping BOSL2 would leave every affected part serving stale geometry from a
 * content address that no longer describes it.
 *
 * Memoised with a short TTL. If the builder is unreachable we deliberately fall
 * back to the empty digest rather than inventing one: that reproduces the
 * pre-library hash, which is wrong-but-stable, instead of scattering
 * uncacheable one-off hashes across the table.
 */
let cachedDigest: { value: string; at: number } | null = null;
const DIGEST_TTL_MS = 60_000;

export async function environmentDigest(): Promise<string> {
  const now = Date.now();
  if (cachedDigest && now - cachedDigest.at < DIGEST_TTL_MS) return cachedDigest.value;

  const health = await builderHealth();
  const digest = typeof health.libraryDigest === "string" ? health.libraryDigest : "";
  if (digest !== "") cachedDigest = { value: digest, at: now };
  return digest;
}
