/**
 * The supply audit.
 *
 * The question this answers is the kill criterion from the product brief: does
 * enough real-world parametric source build unattended for geometry CI to be a
 * real product rather than a demo that only works on files I wrote myself?
 *
 * Method:
 *   1. Walk each cloned repository for .scad files.
 *   2. Classify statically. Library files -- ones that define modules and
 *      instantiate nothing -- are NOT candidate parts, and counting them as
 *      failures would fabricate a failure rate.
 *   3. Compile each candidate in the real sandbox, with its repository's other
 *      .scad files available so include<> can resolve, and the entry at its
 *      original path so relative includes work.
 *   4. Categorise the outcome, and grade what built against the publish gate.
 *
 *   npx tsx scripts/audit/run.ts [--corpus var/corpus] [--per-repo 12] [--builder http://localhost:8081]
 */
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, relative, dirname, resolve } from "node:path";
import { classify, parseScad, toArgs, validate, type ScadSchema } from "../../packages/scad-schema/src/index.js";
import { evaluateReadiness } from "../../services/api/src/readiness.js";
import type { RepoRecord } from "./fetch-corpus.js";

const MAX_FILE_BYTES = 400_000;
const MAX_PAYLOAD_BYTES = 18_000_000;
const BUILD_TIMEOUT_MS = 25_000;
const CONCURRENCY = 2;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const CORPUS = resolve(arg("corpus", "var/corpus"));
const BUILDER = arg("builder", "http://localhost:8081");
const PER_REPO = Number(arg("per-repo", "12"));

export type Outcome =
  | "built"
  | "no-geometry"
  | "missing-include"
  | "syntax-error"
  | "assertion"
  | "unknown-name"
  | "timeout"
  | "too-large"
  | "other";

interface FileResult {
  repo: string;
  bucket: string;
  license: string | null;
  path: string;
  outcome: Outcome;
  summary: string;
  durationMs: number;
  paramCount: number;
  annotatedCount: number;
  describedCount: number;
  hasExternalInclude: boolean;
  publishable: boolean;
  blockers: string[];
  triangles: number | null;
  solid: boolean | null;
  truncatedPayload: boolean;
}

async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".scad")) out.push(relative(base, full));
  }
  return out;
}

/**
 * Choose which sibling files to ship with the entry, nearest first.
 * OpenSCAD resolves includes relative to the including file, so files in the
 * same directory and its ancestors are the ones most likely to be needed.
 */
function selectFiles(
  all: { path: string; size: number }[],
  entry: string,
  budget: number,
): { paths: string[]; truncated: boolean } {
  const entryDir = dirname(entry);
  const distance = (p: string) => {
    const d = dirname(p);
    if (d === entryDir) return 0;
    if (entryDir.startsWith(d)) return 1 + (entryDir.split("/").length - d.split("/").length);
    if (d.startsWith(entryDir)) return 1 + (d.split("/").length - entryDir.split("/").length);
    return 50 + d.split("/").length;
  };

  const sorted = [...all].sort((a, b) => distance(a.path) - distance(b.path) || a.path.localeCompare(b.path));
  const paths: string[] = [];
  let used = 0;
  let truncated = false;
  for (const f of sorted) {
    if (f.size > MAX_FILE_BYTES) {
      truncated = true;
      continue;
    }
    if (used + f.size > budget) {
      truncated = true;
      continue;
    }
    paths.push(f.path);
    used += f.size;
  }
  return { paths, truncated };
}

interface BuilderResponse {
  ok: boolean;
  summary: string;
  diagnostics: { level: string; raw: string }[];
  metrics: { triangleCount: number; solid: boolean; boundingBox: { size: [number, number, number] }; volumeMm3: number; openEdgeCount: number; nonManifoldEdgeCount: number } | null;
  durationMs: number;
  timedOut: boolean;
}

async function build(
  source: string,
  entry: string,
  files: Record<string, string>,
  args: string[],
): Promise<BuilderResponse> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BUILDER}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, entry, files, args, timeoutMs: BUILD_TIMEOUT_MS }),
    });
    if (res.status === 503) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      return {
        ok: false,
        summary: `builder returned ${res.status}`,
        diagnostics: [],
        metrics: null,
        durationMs: 0,
        timedOut: false,
      };
    }
    return (await res.json()) as BuilderResponse;
  }
  return { ok: false, summary: "builder stayed busy", diagnostics: [], metrics: null, durationMs: 0, timedOut: false };
}

function categorize(build: BuilderResponse): Outcome {
  if (build.timedOut) return "timeout";
  if (build.ok && (build.metrics?.triangleCount ?? 0) > 0) return "built";

  const text = [build.summary, ...build.diagnostics.map((d) => d.raw)].join(" | ");
  if (/above the .* limit/i.test(text)) return "too-large";
  if (/Parser error|syntax error/i.test(text)) return "syntax-error";
  if (/Can'?t open input file|Unable to open/i.test(text)) return "missing-include";
  if (/Assertion .* failed|assert/i.test(text)) return "assertion";
  if (/top level object is empty|no top level geometry|empty model/i.test(text)) return "no-geometry";
  if ((build.metrics?.triangleCount ?? 0) === 0 && build.metrics !== null) return "no-geometry";
  if (/unknown (module|variable|function)/i.test(text)) return "unknown-name";
  return "other";
}

function annotationStats(schema: ScadSchema) {
  const visible = schema.params.filter((p) => !schema.hidden.includes(p.name));
  const annotated = visible.filter(
    (p) =>
      p.widget.kind === "slider" ||
      p.widget.kind === "select" ||
      (p.widget.kind === "vector" && p.widget.min !== undefined) ||
      (p.widget.kind === "text" && p.widget.maxLength !== undefined),
  );
  return {
    paramCount: visible.length,
    annotatedCount: annotated.length,
    describedCount: visible.filter((p) => p.description).length,
  };
}

async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!, i);
      }
    }),
  );
}

async function main() {
  const repos = JSON.parse(await readFile(join(CORPUS, "repos.json"), "utf8")) as RepoRecord[];
  console.log(`Auditing ${repos.length} repositories from ${CORPUS}\n`);

  const results: FileResult[] = [];
  const perRepo: { repo: string; scad: number; libraries: number; candidates: number; sampled: number }[] = [];
  const jobs: {
    repo: RepoRecord;
    entry: string;
    source: string;
    files: Record<string, string>;
    truncated: boolean;
  }[] = [];

  for (const repo of repos) {
    const paths = await walk(repo.dir);
    if (paths.length === 0) {
      perRepo.push({ repo: repo.fullName, scad: 0, libraries: 0, candidates: 0, sampled: 0 });
      continue;
    }

    const sized: { path: string; size: number }[] = [];
    for (const p of paths) {
      try {
        sized.push({ path: p, size: (await stat(join(repo.dir, p))).size });
      } catch {
        /* vanished */
      }
    }

    const candidates: string[] = [];
    let libraries = 0;
    for (const f of sized) {
      if (f.size > MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = await readFile(join(repo.dir, f.path), "utf8");
      } catch {
        continue;
      }
      if (classify(text).hasTopLevelGeometry) candidates.push(f.path);
      else libraries++;
    }

    // Sample evenly across the sorted list so one deep directory cannot dominate.
    candidates.sort();
    const step = Math.max(1, Math.ceil(candidates.length / PER_REPO));
    const sampled = candidates.filter((_, i) => i % step === 0).slice(0, PER_REPO);

    perRepo.push({
      repo: repo.fullName,
      scad: sized.length,
      libraries,
      candidates: candidates.length,
      sampled: sampled.length,
    });

    for (const entry of sampled) {
      const source = await readFile(join(repo.dir, entry), "utf8");
      const { paths: keep, truncated } = selectFiles(
        sized.filter((f) => f.path !== entry),
        entry,
        MAX_PAYLOAD_BYTES - Buffer.byteLength(source, "utf8"),
      );
      const files: Record<string, string> = {};
      for (const p of keep) {
        try {
          files[p] = await readFile(join(repo.dir, p), "utf8");
        } catch {
          /* skip */
        }
      }
      jobs.push({ repo, entry, source, files, truncated });
    }
  }

  console.log(`${jobs.length} candidate parts to compile\n`);

  let done = 0;
  await pool(jobs, CONCURRENCY, async (job) => {
    const schema = parseScad(job.source);
    const { values } = validate(schema, {});
    const result = await build(job.source, job.entry, job.files, toArgs(schema, values));
    const outcome = categorize(result);
    const stats = annotationStats(schema);
    const readiness = evaluateReadiness(schema, {
      ok: result.ok,
      summary: result.summary,
      metrics: result.metrics,
    });

    results.push({
      repo: job.repo.fullName,
      bucket: job.repo.bucket,
      license: job.repo.license,
      path: job.entry,
      outcome,
      summary: result.summary.slice(0, 200),
      durationMs: result.durationMs,
      ...stats,
      hasExternalInclude: classify(job.source).includes.some((i) => !(i in job.files)),
      publishable: readiness.ready,
      blockers: readiness.blockers,
      triangles: result.metrics?.triangleCount ?? null,
      solid: result.metrics?.solid ?? null,
      truncatedPayload: job.truncated,
    });

    done++;
    if (done % 10 === 0 || done === jobs.length) {
      process.stdout.write(`\r  compiled ${done}/${jobs.length}`);
    }
  });
  console.log("\n");

  await mkdir("var/audit", { recursive: true });
  await writeFile(
    "var/audit/results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), perRepo, results }, null, 2),
  );

  report(results, perRepo);
}

function pct(n: number, total: number): string {
  return total === 0 ? "  0%" : `${Math.round((n / total) * 100)}%`.padStart(4);
}

function report(results: FileResult[], perRepo: { scad: number; libraries: number; candidates: number }[]) {
  const totalScad = perRepo.reduce((a, r) => a + r.scad, 0);
  const totalLib = perRepo.reduce((a, r) => a + r.libraries, 0);
  const totalCandidates = perRepo.reduce((a, r) => a + r.candidates, 0);

  console.log("=".repeat(66));
  console.log("CORPUS");
  console.log("=".repeat(66));
  console.log(`  .scad files found          ${totalScad}`);
  console.log(`  library files (no geometry) ${totalLib}  ${pct(totalLib, totalScad)}`);
  console.log(`  candidate parts            ${totalCandidates}  ${pct(totalCandidates, totalScad)}`);
  console.log(`  compiled (sampled)         ${results.length}`);

  const order: Outcome[] = [
    "built",
    "missing-include",
    "syntax-error",
    "no-geometry",
    "assertion",
    "unknown-name",
    "timeout",
    "too-large",
    "other",
  ];
  console.log(`\n${"=".repeat(66)}\nBUILD OUTCOMES\n${"=".repeat(66)}`);
  for (const o of order) {
    const n = results.filter((r) => r.outcome === o).length;
    if (n === 0) continue;
    const bar = "█".repeat(Math.round((n / results.length) * 34));
    console.log(`  ${o.padEnd(16)} ${String(n).padStart(4)}  ${pct(n, results.length)}  ${bar}`);
  }

  const built = results.filter((r) => r.outcome === "built");
  console.log(`\n${"=".repeat(66)}\nOF THE ${built.length} THAT BUILT\n${"=".repeat(66)}`);
  const withParams = built.filter((r) => r.paramCount > 0);
  const withAnnotations = built.filter((r) => r.annotatedCount > 0);
  const described = built.filter((r) => r.describedCount > 0);
  const solid = built.filter((r) => r.solid);
  const publishable = built.filter((r) => r.publishable);
  console.log(`  has any parameter          ${String(withParams.length).padStart(4)}  ${pct(withParams.length, built.length)}`);
  console.log(`  has Customizer annotations ${String(withAnnotations.length).padStart(4)}  ${pct(withAnnotations.length, built.length)}`);
  console.log(`  has described parameters   ${String(described.length).padStart(4)}  ${pct(described.length, built.length)}`);
  console.log(`  watertight solid           ${String(solid.length).padStart(4)}  ${pct(solid.length, built.length)}`);
  console.log(`  passes the publish gate    ${String(publishable.length).padStart(4)}  ${pct(publishable.length, built.length)}`);

  console.log(`\n${"=".repeat(66)}\nBY POPULARITY BUCKET\n${"=".repeat(66)}`);
  console.log(`  ${"bucket".padEnd(11)} ${"n".padStart(4)} ${"built".padStart(6)} ${"annotated".padStart(10)} ${"publishable".padStart(12)}`);
  for (const bucket of ["popular", "known", "modest", "long-tail"]) {
    const rows = results.filter((r) => r.bucket === bucket);
    if (rows.length === 0) continue;
    const b = rows.filter((r) => r.outcome === "built");
    console.log(
      `  ${bucket.padEnd(11)} ${String(rows.length).padStart(4)} ${pct(b.length, rows.length).padStart(6)} ` +
        `${pct(b.filter((r) => r.annotatedCount > 0).length, b.length).padStart(10)} ` +
        `${pct(b.filter((r) => r.publishable).length, rows.length).padStart(12)}`,
    );
  }

  const licensed = results.filter((r) => r.license && !["NOASSERTION"].includes(r.license));
  console.log(`\n${"=".repeat(66)}\nSEEDABLE SUBSET\n${"=".repeat(66)}`);
  const seedable = built.filter(
    (r) => r.publishable && r.annotatedCount > 0 && r.license && r.license !== "NOASSERTION",
  );
  console.log(`  clearly licensed           ${String(licensed.length).padStart(4)}  ${pct(licensed.length, results.length)}`);
  console.log(`  builds + annotated + licensed + passes gate  ${String(seedable.length).padStart(4)}  ${pct(seedable.length, results.length)}`);
  console.log(`  from ${new Set(seedable.map((r) => r.repo)).size} distinct repositories`);

  const times = built.map((r) => r.durationMs).sort((a, b) => a - b);
  if (times.length > 0) {
    const median = times[Math.floor(times.length / 2)]!;
    const p90 = times[Math.floor(times.length * 0.9)]!;
    console.log(`\n  build time: median ${median} ms, p90 ${p90} ms, max ${times[times.length - 1]} ms`);
  }
  const truncated = results.filter((r) => r.truncatedPayload).length;
  if (truncated > 0) {
    console.log(`  NOTE: ${truncated} builds had their file payload truncated by the size cap.`);
  }
  console.log("\nFull results: var/audit/results.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
