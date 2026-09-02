# Datum

A registry for parametric parts. **The source is the artifact, and the build is the quality gate.**

You don't upload a mesh. You publish the parametric source that *generates* the part. Datum
compiles it in a sandbox on every change, measures the geometry it produced, and refuses to list
anything that doesn't build. Parts declare the mechanical interfaces they mate with, so you can
search by fit rather than by keyword.

This repo is the milestone-1 vertical slice: **configure → compile → measure → download**, which is
also the landing-page experiment from the validation plan. It is deliberately the same artifact,
because the fastest way to test "will people configure rather than take the default file?" is to
build the thing that lets them.

---

## Current state

| Piece | Status |
|---|---|
| Customizer schema parser (`@datum/scad-schema`) | Working, 40 tests |
| Parameter validation and safe `-D` serialization | Working |
| Sandboxed OpenSCAD build service | Working, isolated |
| STL parsing + geometry measurement | Working, 30 tests |
| Plain-language build diagnostics | Working |
| Registry API (parts, builds, cache, fit search, made reports) | Working |
| Configurator UI with live 3D preview | Working |
| Publish flow, forking, revision requests, accounts | **Not built** |

## Quick start

```bash
cp .env.example .env
docker compose up -d          # postgres + build sandbox + api
npm install
npm run -w @datum/api seed    # interface vocabulary + seed parts
npm run dev:web               # http://localhost:5173
```

The web app proxies `/api` to port 8080. Postgres is published on **5433**, not 5432, to avoid
colliding with an existing local Postgres.

Verify the whole pipeline without the browser:

```bash
npx tsx scripts/smoke.ts
```

That parses a schema, validates a configuration, compiles two variants, diffs them geometrically,
and checks that broken and empty sources fail with useful messages.

## How it fits together

```
apps/web            Vite + React configurator; three.js STL viewer
services/api        Fastify + Postgres. Validation, build cache, artifacts, fit search.
services/builder    Fastify + OpenSCAD. Isolated. Knows nothing about schemas or the registry.
packages/scad-schema  Pure logic: parse Customizer annotations, validate, serialize, hash.
db/migrations       SQL, applied on API start.
seed/               Seed parts.
```

The builder is deliberately dumb: it receives pre-serialized `-D` arguments and returns geometry
plus measurements. It has no database access, no knowledge of parts, and no network. That keeps the
component running untrusted code as small and as boring as possible.

### Why OpenSCAD first

OpenSCAD already has a Customizer annotation syntax — parameter descriptions, ranges, and dropdowns
declared in comments. Rather than invent a manifest format and ask authors to restate what they've
already written, Datum reads theirs. A part that works in the OpenSCAD GUI gets a Datum
configurator with no extra authoring. That is the "publishing is a side effect of something you
needed anyway" bet from the product brief, made concrete.

The cost is that OpenSCAD only emits meshes, so measurements are mesh-derived (bounding box,
volume, watertightness) and there's no STEP export. A `build123d`/OCCT backend behind the same
build interface is the intended second kernel.

## Security posture of the build sandbox

Parametric source is code, and this service exists to run strangers' code. Current controls:

- **No network egress** — the builder sits on a Docker `internal` network. Verified, not assumed.
- **Unprivileged, read-only root** with a `tmpfs` for scratch; all capabilities dropped;
  `no-new-privileges`.
- **Memory, CPU and PID ceilings** per container.
- **Wall-clock timeout** enforced in-process with `SIGKILL`, plus an output size cap.
- **Fresh temp directory per build**, environment stripped to `PATH`, removed afterwards.
- **No parameter injection**: values are re-emitted from typed data via `serializeValue`, never
  passed through as text, and parameter *names* come from parsed source rather than user input.

Not yet done: per-build container isolation (currently one container serves sequential builds),
gVisor/Firecracker, and any authenticated rate limiting.

## Design decisions worth knowing

- **Fit-based semver.** Major = mating surfaces moved and downstream parts may no longer fit;
  minor = new capability that still fits; patch = fix with no interface change. Versioning that
  means something physical.
- **Interfaces are rows, not tags.** `extrusion/2020-tslot`, `motor/nema17-face`, `bearing/608`.
  A part declares what it `implements` and what it `consumes`. This is the intended dependency
  graph and the reason `/api/search/fit` can answer a question no mesh site can.
- **Artifacts are derived, never uploaded.** Anything in the artifact store can be regenerated from
  source, so it is safe to evict and storage never becomes the cost centre.
- **Builds are content-addressed** on `hash(source, parameters)`, which makes the cache correct by
  construction and gives every configuration a citable identity.
- **`configured` is recorded on every build.** Whether the requester changed at least one parameter
  from its default is *the* metric the validation plan turns on, so it is a column, not something to
  reconstruct from logs later.
- **A failed build keeps the last good geometry on screen**, clearly badged. Blanking the viewport
  every time a slider crosses an invalid range is worse than a labelled stale model.

## Deliberately not built yet

Publishing, accounts, forking, revision requests, geometric diff visualisation, dependency
resolution, and anything social. Mesh upload is not a missing feature — accepting meshes would
delete the entire technical differentiator, and the answer is no.

## Next

1. Publish flow: point Datum at existing source, get a build report, declare interfaces, pick a
   licence.
2. Seed 100+ parts by importing permissively-licensed parametric source, which doubles as the
   supply audit from the validation plan.
3. Geometric diff between two builds — the visible payoff of everything above.
