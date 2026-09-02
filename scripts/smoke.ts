/**
 * End-to-end smoke test: source -> schema -> validated parameters -> compiled
 * geometry -> measurements. Run against a live builder:
 *
 *   npx tsx scripts/smoke.ts [builderUrl]
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildHash, hashSource, parseScad, toArgs, validate } from "../packages/scad-schema/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const BUILDER = process.argv[2] ?? process.env.BUILDER_URL ?? "http://localhost:8081";

interface BuildResponse {
  ok: boolean;
  summary: string;
  diagnostics: { level: string; raw: string; explanation?: string }[];
  metrics: {
    triangleCount: number;
    boundingBox: { size: [number, number, number] };
    volumeMm3: number;
    surfaceAreaMm2: number;
    watertight: boolean;
    solid: boolean;
  } | null;
  durationMs: number;
  artifacts: { stl: string | null; png: string | null };
}

const fmt = (n: number, d = 2) => n.toFixed(d).replace(/\.?0+$/, "");

async function buildOnce(source: string, args: string[], preview: boolean): Promise<BuildResponse> {
  const res = await fetch(`${BUILDER}/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, args, renderPreview: preview }),
  });
  if (!res.ok && res.status >= 500) throw new Error(`builder returned ${res.status}`);
  return (await res.json()) as BuildResponse;
}

async function main() {
  const source = await readFile(join(here, "..", "seed", "bracket-2020", "bracket.scad"), "utf8");
  const srcHash = hashSource(source);

  console.log("=== 1. Parse the Customizer schema out of the source ===");
  const schema = parseScad(source);
  console.log(`groups:   ${schema.groups.join(", ")}`);
  console.log(`hidden:   ${schema.hidden.join(", ") || "(none)"}`);
  console.log(`warnings: ${schema.warnings.length}`);
  for (const p of schema.params) {
    const w =
      p.widget.kind === "slider"
        ? `slider ${p.widget.min}..${p.widget.max} step ${p.widget.step}`
        : p.widget.kind === "select"
          ? `select(${p.widget.options.map((o) => o.label).join("|")})`
          : p.widget.kind;
    console.log(`  ${p.group.padEnd(14)} ${p.name.padEnd(12)} ${String(p.default).padEnd(8)} ${w}`);
  }

  console.log("\n=== 2. Validate a requested configuration ===");
  const requested = { arm: 60, bolt_d: 4, holes: 2, gusset: false };
  const result = validate(schema, requested);
  console.log(`requested: ${JSON.stringify(requested)}`);
  console.log(`ok:        ${result.ok}  errors: ${JSON.stringify(result.errors)}`);
  console.log(`buildHash: ${buildHash(srcHash, result.values).slice(0, 16)}`);

  const bad = validate(schema, { bolt_d: 99, nonsense: 1 });
  console.log(`rejects out-of-range + unknown: ${JSON.stringify(bad.errors)}`);

  console.log("\n=== 3. Compile the default configuration ===");
  const defaults = validate(schema, {});
  const a = await buildOnce(source, toArgs(schema, defaults.values), true);
  report("defaults", a);

  console.log("\n=== 4. Compile the requested configuration ===");
  const b = await buildOnce(source, toArgs(schema, result.values), false);
  report("arm=60, holes=2, no gusset", b);

  if (a.metrics && b.metrics) {
    console.log("\n=== 5. Geometric diff between the two ===");
    const d = (x: number, y: number) => `${fmt(x)} -> ${fmt(y)}  (${y > x ? "+" : ""}${fmt(y - x)})`;
    console.log(`  bbox X:   ${d(a.metrics.boundingBox.size[0], b.metrics.boundingBox.size[0])} mm`);
    console.log(`  bbox Y:   ${d(a.metrics.boundingBox.size[1], b.metrics.boundingBox.size[1])} mm`);
    console.log(`  bbox Z:   ${d(a.metrics.boundingBox.size[2], b.metrics.boundingBox.size[2])} mm`);
    console.log(`  volume:   ${d(a.metrics.volumeMm3, b.metrics.volumeMm3)} mm3`);
    console.log(`  mass PETG:${d((a.metrics.volumeMm3 / 1000) * 1.27, (b.metrics.volumeMm3 / 1000) * 1.27)} g`);
  }

  console.log("\n=== 6. A build that should fail, and explain itself ===");
  const broken = await buildOnce("cube([10, 10, 10)\n", [], false);
  console.log(`  ok:      ${broken.ok}`);
  console.log(`  summary: ${broken.summary}`);
  for (const dg of broken.diagnostics.slice(0, 3)) {
    console.log(`  ${dg.level}: ${dg.raw}`);
    if (dg.explanation) console.log(`     -> ${dg.explanation}`);
  }

  console.log("\n=== 7. A build that produces nothing ===");
  const empty = await buildOnce("// nothing here\nx = 1;\n", [], false);
  console.log(`  ok:      ${empty.ok}`);
  console.log(`  summary: ${empty.summary}`);

  const failures: string[] = [];
  if (!a.ok) failures.push("default build failed");
  if (!b.ok) failures.push("configured build failed");
  if (a.metrics && !a.metrics.solid) failures.push("default build is not a solid");
  if (a.metrics && a.metrics.boundingBox.size[0] !== 40) failures.push("default bbox X is not 40mm");
  if (b.metrics && b.metrics.boundingBox.size[0] !== 60) failures.push("configured bbox X is not 60mm");
  if (broken.ok) failures.push("syntactically invalid source reported success");
  if (empty.ok) failures.push("empty geometry reported success");
  if (!a.artifacts.png) failures.push("preview render produced no PNG");

  console.log("");
  if (failures.length > 0) {
    console.error(`SMOKE FAILED:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("SMOKE PASSED: schema, validation, compile, measure, diff and failure reporting all work.");
}

function report(label: string, r: BuildResponse) {
  console.log(`  ${label}: ok=${r.ok} in ${r.durationMs}ms - ${r.summary}`);
  if (r.metrics) {
    const m = r.metrics;
    console.log(
      `    ${m.triangleCount} triangles, bbox ${m.boundingBox.size.map((n) => fmt(n)).join(" x ")} mm`,
    );
    console.log(
      `    volume ${fmt(m.volumeMm3, 1)} mm3, area ${fmt(m.surfaceAreaMm2, 1)} mm2, watertight=${m.watertight}, solid=${m.solid}`,
    );
  }
  if (r.artifacts.stl) {
    console.log(`    STL ${(Buffer.from(r.artifacts.stl, "base64").length / 1024).toFixed(1)} KB`);
  }
  if (r.artifacts.png) {
    console.log(`    PNG ${(Buffer.from(r.artifacts.png, "base64").length / 1024).toFixed(1)} KB`);
  }
  for (const d of r.diagnostics) console.log(`    ${d.level}: ${d.raw}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
