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
| Customizer schema parser (`@datum/scad-schema`) | Working, 94 tests |
| Parameter validation and safe `-D` serialization | Working |
| Sandboxed OpenSCAD build service | Working, isolated |
| STL parsing + geometry measurement | Working, 30 tests |
| Plain-language build diagnostics | Working |
| Registry API (parts, builds, cache, fit search, made reports) | Working |
| Configurator UI with live 3D preview | Working |
| Publish flow with a readiness gate | Working, 15 tests |
| Fit-based semver with automatic bump proposal | Working, 20 tests |
| Library resolution (search paths + vendored BOSL2/Round-Anything/MCAD) | Working |
| Assisted annotation of unannotated parameters | Working, 20 tests |
| Minimal handle ownership (token, not accounts) | Working |
| Forking, revision requests, geometric diff UI | **Not built** |

## Quick start

```bash
cp .env.example .env
docker compose up -d          # postgres + build sandbox + api
npm install
npm run -w @datum/api seed    # interface vocabulary + seed parts
npm run dev:web               # http://localhost:5173
```

Then open <http://localhost:5173/publish> and paste some OpenSCAD.

The web app proxies `/api` to port 8080. Postgres is published on **5433**, not 5432, to avoid
colliding with an existing local Postgres.

Verify the whole pipeline without the browser:

```bash
npx tsx scripts/smoke.ts
```

That parses a schema, validates a configuration, compiles two variants, diffs them geometrically,
and checks that broken and empty sources fail with useful messages.

## Publishing

Publishing is a gate, not a form. You point Datum at source; it compiles the default
configuration in the sandbox, measures the result, and grades it:

| Check | Blocks publishing |
|---|---|
| Compiles to geometry | **yes** |
| Has configurable parameters | **yes** |
| Closed, watertight solid | no |
| Parameters are described | no |
| Numeric parameters have ranges | no |
| No schema warnings | no |
| Plausible physical size | no |

The two blocking checks are the ones that keep this a registry rather than a file dump. The
second one is the anti-mesh rule in disguise: a part with no parameters is a fixed model, and
fixed models are what every other site already has. The rest are quality advice, shown while the
author is still looking at the file and most likely to act on it. `Plausible physical size` exists
because modelling in metres is the most common way a part is technically valid and totally useless.

Publishing re-runs the whole preflight server-side rather than trusting what the client reports,
so a caller cannot assert its own readiness. The build produced by publishing is stored as the
version's canonical default build, which means the first person to open the part page gets a cache
hit rather than a cold compile.

### Version bumps are proposed from evidence

Fit-based semver only works if the numbers mean something, and authors reliably forget the rules.
So `POST /api/parts/:owner/:slug/versions/propose` diffs the new schema against the released one,
compares the measured geometry, and proposes the bump:

- **major** — a parameter was removed, a range narrowed, a dropdown option disappeared, a type
  changed, the default build's envelope moved, or the part stopped being a closed solid. All of
  these break someone holding a saved configuration.
- **minor** — a parameter or option was added, a range widened, a default changed, or internal
  geometry moved while the envelope held.
- **patch** — nothing detectable changed.

The author may publish a *larger* bump than proposed but never a smaller one; the evidence is a
floor. When a default value changed, geometry comparison is explicitly abandoned and says so — the
two default builds are different configurations, so a size difference proves nothing.

The honest limitation travels with every proposal: OpenSCAD emits meshes, not B-rep, so geometry is
compared at the whole-part level. A change that rotates a bolt circle while keeping the same
envelope will not be caught. It is a proposal, never applied silently.

### Ownership

There is no account system. Claiming a handle mints a token once, stored in the browser and
unrecoverable; publishing to that handle requires it. That is enough to stop one author publishing
under another's name in development and no more. It must be replaced before this is public — the
trust-and-safety work (DMCA, ownership disputes, moderation) all assumes real identities.

## How it fits together

```
apps/web            Vite + React configurator; three.js STL viewer
services/api        Fastify + Postgres. Validation, build cache, artifacts, fit search.
services/builder    Fastify + OpenSCAD. Isolated. Knows nothing about schemas or the registry.
packages/scad-schema  Pure logic: parse Customizer annotations, validate, serialize, hash, diff.
db/migrations       SQL, applied on API start.
seed/               Seed parts.
```

The builder is deliberately dumb: it receives pre-serialized `-D` arguments and returns geometry
plus measurements. It has no database access, no knowledge of parts, and no network. That keeps the
component running untrusted code as small and as boring as possible.

### Library resolution

Builds are isolated, but total isolation was the single biggest cause of failure in the supply
audit — and mostly not for the reason expected. Two mechanisms now resolve includes:

1. **Search paths from the part's own files.** Many projects are written to be *installed*: their
   examples say `include <src/thing.scad>` and expect the project on `OPENSCADPATH` rather than
   beside the file. A build request can name directories within the part to put on the search path.
2. **A small vendored library set**, pinned to immutable commits and baked into the sandbox image:
   BOSL2, Round-Anything and MCAD. See `services/builder/libraries.json`.

Precedence is build root → the part's declared directories → vendored libraries, so **a part can
always shadow a library** with its own file of the same name.

The library set has a digest, and that digest is folded into every build hash. Bumping BOSL2 changes
what parts compile to, so it must invalidate cached artifacts rather than leave them serving stale
geometry under a content address that no longer describes them.

This is deliberately not a package manager. It is a short list of libraries common enough that
almost every part assuming one assumes one of these; anything more exotic gets published with the
part.

### Assisted annotation

The audit found only 2% of parameters in real source carry a range, so reading the author's
annotations is not enough — most parts would render as a column of bare number boxes. Preflight
therefore *proposes* ranges, from the parameter's name (mechanical CAD has real conventions for
`tolerance`, `wall`, `bolt_d`, `angle`, `count`) and from the default's magnitude.

Nothing is applied silently. A wrong range is worse than no range, because it rejects
configurations the part genuinely supports — so name matches are high confidence and pre-selected,
value-bracketed guesses are low and are not, negative defaults are declined rather than guessed, and
a proposal is never allowed to exclude the author's own default. Accepted ranges are written back as
ordinary Customizer comments, so they work in plain OpenSCAD too.

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

## Does this work on real source?

Measured, not assumed: [`docs/supply-audit.md`](docs/supply-audit.md) compiles 238 candidate parts
from 44 real GitHub repositories through the actual sandbox.

- **60% build completely.** The kill criterion from the brief is passed.
- **14% of parts that produced geometry were silently incomplete**, and 19 of those 23 were
  watertight — a healthy-looking dimension report on a part with pieces missing. OpenSCAD downgrades
  an unresolvable `include <>` to a warning and carries on. That is now a build failure.
- **Only 2% of parameters carry a Customizer annotation.** The "authors already annotated, so the
  configurator is free" assumption does not survive contact with real code — hence assisted
  annotation.
- **Compute time is the binding constraint**, not include resolution: 86% of parts build in under
  25 s, the rest need much longer.

Re-run it with `npx tsx scripts/audit/fetch-corpus.ts && npx tsx scripts/audit/run.ts`.

## Deliberately not built yet

Real accounts, forking, revision requests, geometric diff visualisation, dependency resolution,
and anything social. Mesh upload is not a missing feature — accepting meshes would delete the
entire technical differentiator, and the answer is no.

## Next

1. **Seed the registry.** The import harness, library resolution and the readiness gate all exist
   now; what does not exist is content. ~400 repositories would yield ~500 parts at the measured
   rate.
2. **Split the build budget.** Compute time, not include resolution, is now the binding constraint.
   Interactive configuration needs a short timeout; a one-off publish build can afford far more.
3. **Forking** — the permissionless-improvement primitive. The ancestry column and the schema diff
   already exist; the revision-request flow and UI do not.
