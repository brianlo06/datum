/**
 * Re-run only the builds that timed out, with a much larger budget.
 *
 * Adding library resolution made the measured build rate *fall* (70% -> 50%)
 * while timeouts rose from 14 to 67. The hypothesis is that this is not a
 * regression but a correction: a part with an unresolved include used to emit a
 * warning, skip that geometry, and finish quickly with a partial model that the
 * audit scored as "built". Now the include resolves, the full model is actually
 * generated, and the real cost shows up.
 *
 * If that is right, most of the new timeouts should succeed given more time, and
 * the earlier 70% was partly measuring silently-incomplete builds.
 *
 *   npx tsx scripts/audit/retry-timeouts.ts [--timeout 120000]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseScad, toArgs, validate } from "../../packages/scad-schema/src/index.js";
import type { RepoRecord } from "./fetch-corpus.js";
import { filesFor, searchPathsFor, walkRepo } from "./shared.js";

const CORPUS = resolve("var/corpus");
const BUILDER = "http://localhost:8081";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const TIMEOUT = Number(arg("timeout", "120000"));

interface Row {
  repo: string;
  path: string;
  outcome: string;
  durationMs: number;
  triangles: number | null;
}

async function main() {
  const audit = JSON.parse(await readFile("var/audit/results.json", "utf8")) as {
    results: Row[];
  };
  const repos = new Map(
    (JSON.parse(await readFile(join(CORPUS, "repos.json"), "utf8")) as RepoRecord[]).map(
      (r) => [r.fullName, r.dir] as const,
    ),
  );

  const timeouts = audit.results.filter((r) => r.outcome === "timeout");
  console.log(`Retrying ${timeouts.length} timed-out builds with a ${TIMEOUT / 1000}s budget\n`);

  const outcomes: { repo: string; path: string; ok: boolean; ms: number; triangles: number }[] = [];

  for (const [i, row] of timeouts.entries()) {
    const dir = repos.get(row.repo);
    if (!dir) continue;
    const full = join(dir, row.path);
    let source: string;
    try {
      source = await readFile(full, "utf8");
    } catch {
      continue;
    }

    // Same file set and search paths the main audit used.
    const all = await walkRepo(dir);
    const { files } = await filesFor(dir, all, row.path, Buffer.byteLength(source, "utf8"));
    const schema = parseScad(source);
    const { values } = validate(schema, {});

    const started = Date.now();
    const res = await fetch(`${BUILDER}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        entry: row.path,
        files,
        args: toArgs(schema, values),
        searchPaths: searchPathsFor(all),
        timeoutMs: TIMEOUT,
      }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      metrics?: { triangleCount: number } | null;
      summary?: string;
    };
    const ms = Date.now() - started;
    const ok = body.ok === true && (body.metrics?.triangleCount ?? 0) > 0;
    outcomes.push({ repo: row.repo, path: row.path, ok, ms, triangles: body.metrics?.triangleCount ?? 0 });

    process.stdout.write(
      `\r  ${i + 1}/${timeouts.length}  ${ok ? "built" : "still failing"}  ${(ms / 1000).toFixed(1)}s  ${row.path.slice(-46)}          `,
    );
  }

  console.log("\n");
  const built = outcomes.filter((o) => o.ok);
  console.log(`${built.length}/${outcomes.length} of the timeouts built when given ${TIMEOUT / 1000}s.`);
  if (built.length > 0) {
    const times = built.map((o) => o.ms).sort((a, b) => a - b);
    console.log(
      `  their build times: median ${(times[Math.floor(times.length / 2)]! / 1000).toFixed(1)}s, ` +
        `max ${(times[times.length - 1]! / 1000).toFixed(1)}s`,
    );
    console.log(`  median triangles: ${built.map((o) => o.triangles).sort((a, b) => a - b)[Math.floor(built.length / 2)]!.toLocaleString()}`);
  }
  await writeFile("var/audit/timeout-retry.json", JSON.stringify(outcomes, null, 2));
  console.log("\nWritten to var/audit/timeout-retry.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
