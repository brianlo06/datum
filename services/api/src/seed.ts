/**
 * Seed the registry with the starter interface vocabulary and the seed parts.
 *
 * The interface list is deliberately small and real. Part 6 of the brief calls
 * for 20-30 genuine mechanical interfaces defined properly rather than an
 * ontology invented in isolation; this is the first slice of that, covering the
 * standards the initial niche actually builds against.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashSource, parseScad } from "@datum/scad-schema";
import { pool, migrate, withTransaction } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(here, "..", "..", "..", "seed");

const INTERFACES: [slug: string, name: string, description: string][] = [
  ["extrusion/2020-tslot", "2020 T-slot extrusion", "20x20mm aluminium extrusion with a 6mm T-slot."],
  ["extrusion/3030-tslot", "3030 T-slot extrusion", "30x30mm aluminium extrusion with an 8mm T-slot."],
  ["extrusion/2040-tslot", "2040 T-slot extrusion", "20x40mm aluminium extrusion with a 6mm T-slot."],
  ["gridfinity/baseplate", "Gridfinity baseplate", "42x42mm grid with the standard Gridfinity profile."],
  ["gridfinity/bin", "Gridfinity bin", "A bin that seats into a Gridfinity baseplate."],
  ["motor/nema17-face", "NEMA 17 face", "31mm bolt circle, 22mm pilot, 5mm shaft."],
  ["motor/nema23-face", "NEMA 23 face", "47.14mm bolt circle, 38.1mm pilot."],
  ["bearing/608", "608 bearing", "22mm OD, 8mm ID, 7mm wide skate bearing."],
  ["bearing/625", "625 bearing", "16mm OD, 5mm ID, 5mm wide."],
  ["bearing/lm8uu", "LM8UU linear bearing", "15mm OD, 8mm ID, 24mm long."],
  ["fastener/m3-clearance", "M3 clearance hole", "3.2-3.4mm through hole for an M3 bolt."],
  ["fastener/m4-clearance", "M4 clearance hole", "4.3mm through hole for an M4 bolt."],
  ["fastener/m5-clearance", "M5 clearance hole", "5.3mm through hole for an M5 bolt."],
  ["fastener/m3-heatset", "M3 heat-set insert", "Standard 4.0mm x 5.0mm brass heat-set insert pocket."],
  ["fastener/m3-hexnut", "M3 hex nut pocket", "5.5mm across flats, 2.4mm deep."],
  ["mount/vesa-75", "VESA 75", "75x75mm M4 mounting pattern."],
  ["mount/vesa-100", "VESA 100", "100x100mm M4 mounting pattern."],
  ["mount/din-rail-35", "35mm DIN rail", "EN 50022 top-hat rail."],
  ["rail/mgn12", "MGN12 linear rail", "12mm linear rail with the MGN12H/C carriage pattern."],
  ["pi/rpi4-mount", "Raspberry Pi 4 mount", "58x49mm M2.5 mounting pattern."],
  ["pi/rpi5-mount", "Raspberry Pi 5 mount", "58x49mm M2.5 mounting pattern with the Pi 5 connector layout."],
  ["camera/gopro-tab", "GoPro tab mount", "Standard two- and three-tab GoPro fork with a 5mm pin."],
  ["camera/quarter-20", "1/4-20 tripod thread", "Standard 1/4 inch UNC-20 camera thread."],
  ["belt/gt2-6mm", "GT2 6mm belt", "2mm pitch, 6mm wide toothed belt."],
  ["tube/pc4-fitting", "PC4 bowden fitting", "M6 threaded pneumatic fitting for 4mm OD PTFE tube."],
];

/** Seed parts, with the interfaces each one declares. */
const PARTS: {
  dir: string;
  slug: string;
  title: string;
  summary: string;
  license: string;
  version: string;
  entry: string;
  implements: string[];
  consumes: string[];
}[] = [
  {
    dir: "bracket-2020",
    entry: "bracket.scad",
    slug: "corner-bracket-2020",
    title: "2020 Corner Bracket",
    summary:
      "A right-angle bracket for bolting two lengths of 2020 aluminium extrusion together. Every dimension is parametric, and an assertion rejects hole layouts that would fall off the end of the arm.",
    license: "CC-BY-4.0",
    version: "1.0.0",
    implements: [],
    consumes: ["extrusion/2020-tslot", "fastener/m5-clearance"],
  },
];

async function main() {
  const ran = await migrate();
  if (ran.length > 0) console.log(`applied migrations: ${ran.join(", ")}`);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users (handle, display_name) VALUES ('datum', 'Datum')
       ON CONFLICT (handle) DO NOTHING`,
    );

    for (const [slug, name, description] of INTERFACES) {
      await client.query(
        `INSERT INTO interfaces (slug, name, description) VALUES ($1,$2,$3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
        [slug, name, description],
      );
    }
    console.log(`interfaces: ${INTERFACES.length}`);

    const { rows: userRows } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE handle = 'datum'",
    );
    const ownerId = userRows[0]!.id;

    for (const part of PARTS) {
      const source = await readFile(join(SEED_DIR, part.dir, part.entry), "utf8");
      const schema = parseScad(source);
      if (schema.warnings.length > 0) {
        console.warn(`  ${part.slug}: ${schema.warnings.length} schema warning(s)`);
        for (const w of schema.warnings) console.warn(`    line ${w.line}: ${w.message}`);
      }

      const { rows: partRows } = await client.query<{ id: string }>(
        `INSERT INTO parts (owner_id, slug, title, summary, license)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (owner_id, slug) DO UPDATE
           SET title = EXCLUDED.title, summary = EXCLUDED.summary,
               license = EXCLUDED.license, updated_at = now()
         RETURNING id`,
        [ownerId, part.slug, part.title, part.summary, part.license],
      );
      const partId = partRows[0]!.id;

      const { rows: versionRows } = await client.query<{ id: string }>(
        `INSERT INTO part_versions (part_id, version, source, source_hash, schema, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (part_id, version) DO UPDATE
           SET source = EXCLUDED.source, source_hash = EXCLUDED.source_hash,
               schema = EXCLUDED.schema
         RETURNING id`,
        [partId, part.version, source, hashSource(source), JSON.stringify(schema), "Initial release."],
      );
      const versionId = versionRows[0]!.id;

      await client.query("DELETE FROM part_interfaces WHERE part_version_id = $1", [versionId]);
      for (const [role, slugs] of [
        ["implements", part.implements],
        ["consumes", part.consumes],
      ] as const) {
        for (const ifaceSlug of slugs) {
          await client.query(
            `INSERT INTO part_interfaces (part_version_id, interface_id, role)
             SELECT $1, i.id, $2 FROM interfaces i WHERE i.slug = $3
             ON CONFLICT DO NOTHING`,
            [versionId, role, ifaceSlug],
          );
        }
      }

      console.log(
        `part: ${part.slug}@${part.version} - ${schema.params.length} parameters in ${schema.groups.length} groups`,
      );
    }
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
