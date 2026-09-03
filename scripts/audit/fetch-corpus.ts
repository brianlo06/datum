/**
 * Build a corpus of real OpenSCAD repositories to audit.
 *
 * Sampling matters here. The top-starred OpenSCAD repos are overwhelmingly
 * *libraries* (BOSL2, NopSCADlib, dotSCAD), which are not what a parts registry
 * would be seeded from. Auditing only those would tell us about library code, not
 * about the parts people actually publish. So the corpus is drawn from several
 * star buckets, giving a spread from famous libraries down to ordinary hobby
 * projects.
 *
 *   npx tsx scripts/audit/fetch-corpus.ts [--per-bucket 10] [--out var/corpus]
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Star ranges sampled separately, so the corpus is not all famous libraries. */
const BUCKETS: { label: string; query: string }[] = [
  { label: "popular", query: "language:OpenSCAD stars:>150" },
  { label: "known", query: "language:OpenSCAD stars:30..150" },
  { label: "modest", query: "language:OpenSCAD stars:8..29" },
  { label: "long-tail", query: "language:OpenSCAD stars:2..7" },
];

export interface RepoRecord {
  bucket: string;
  fullName: string;
  stars: number;
  license: string | null;
  pushedAt: string;
  dir: string;
}

interface GhRepo {
  full_name: string;
  stargazers_count: number;
  license: { spdx_id: string } | null;
  pushed_at: string;
  size: number;
  archived: boolean;
  fork: boolean;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function search(query: string, perPage: number): Promise<GhRepo[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      "-X",
      "GET",
      "search/repositories",
      "-f",
      `q=${query}`,
      "-f",
      "sort=stars",
      "-f",
      "order=desc",
      "-f",
      `per_page=${perPage * 3}`,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return (JSON.parse(stdout) as { items: GhRepo[] }).items ?? [];
}

async function main() {
  const perBucket = Number(arg("per-bucket", "10"));
  const outDir = resolve(arg("out", "var/corpus"));
  await mkdir(outDir, { recursive: true });

  const records: RepoRecord[] = [];
  const seen = new Set<string>();

  for (const bucket of BUCKETS) {
    let taken = 0;
    let items: GhRepo[] = [];
    try {
      items = await search(bucket.query, perBucket);
    } catch (err) {
      console.error(`  search failed for ${bucket.label}: ${(err as Error).message}`);
      continue;
    }

    for (const repo of items) {
      if (taken >= perBucket) break;
      if (seen.has(repo.full_name)) continue;
      // Forks duplicate their upstream, archived repos are frozen, and anything
      // over ~80 MB is a photo dump rather than a source repo.
      if (repo.fork || repo.archived || repo.size > 80_000) continue;

      seen.add(repo.full_name);
      const dir = join(outDir, repo.full_name.replace("/", "__"));

      process.stdout.write(`  [${bucket.label}] ${repo.full_name} (${repo.stargazers_count}*) … `);
      try {
        await execFileAsync(
          "git",
          ["clone", "--depth", "1", "--quiet", `https://github.com/${repo.full_name}.git`, dir],
          { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
        );
        console.log("ok");
      } catch (err) {
        console.log(`clone failed (${(err as Error).message.split("\n")[0]})`);
        continue;
      }

      records.push({
        bucket: bucket.label,
        fullName: repo.full_name,
        stars: repo.stargazers_count,
        license: repo.license?.spdx_id ?? null,
        pushedAt: repo.pushed_at,
        dir,
      });
      taken++;
    }
  }

  await writeFile(join(outDir, "repos.json"), JSON.stringify(records, null, 2));
  console.log(`\n${records.length} repositories cloned into ${outDir}`);
  for (const b of BUCKETS) {
    console.log(`  ${b.label.padEnd(10)} ${records.filter((r) => r.bucket === b.label).length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
