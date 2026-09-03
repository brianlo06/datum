# Supply audit — September 2026

**Question.** The product brief named one kill criterion: *if most real-world parametric source
will not build unattended, geometry CI is a fantasy and the whole differentiator collapses.*
Everything built so far had been validated against source I wrote myself, which is the friendliest
possible input. This measures the unfriendly case.

**Answer.** The thesis survives, but one of its supporting assumptions does not.

- **70% of candidate parts build unattended** (75% excluding runs degraded by a size cap). Geometry
  CI works on real code.
- **Only 2% of parameters carry a Customizer annotation.** The "authors already annotated their
  parameters, so a configurator is free" assumption is essentially false at scale.
- **69% of build failures involve an unresolved external library.** Resolving library dependencies
  would raise the ceiling from 70% to roughly **91%** — the highest-leverage feature this surfaced.

---

## Method

44 repositories cloned from GitHub, sampled across four star buckets so the corpus is not just the
famous libraries — those are unrepresentative of what a parts registry would hold.

| Bucket | Stars | Repos |
|---|---|---|
| popular | >150 | 11 |
| known | 30–150 | 11 |
| modest | 8–29 | 11 |
| long-tail | 2–7 | 11 |

Each `.scad` file was statically classified. **Library files — ones that define modules and
instantiate nothing — are not candidate parts**, and counting them as build failures would
fabricate a failure rate. Of 1,671 `.scad` files, 686 (41%) are libraries and 955 (57%) are
candidate parts. Up to 12 candidates per repository were sampled evenly, giving **238 compiled**.

Each was compiled in the real sandbox, with its repository's other `.scad` files shipped alongside
so `include <>` could resolve, and with the entry file at its original relative path so `../`
includes work. Reproduce with `npx tsx scripts/audit/run.ts`; raw results in `var/audit/results.json`.

## Results

### Build outcomes (238 candidate parts)

| Outcome | n | % |
|---|---:|---:|
| **built** | 167 | **70%** |
| unknown-name (usually a missing library) | 19 | 8% |
| timeout (>25 s) | 14 | 6% |
| syntax error | 11 | 5% |
| assertion rejected the defaults | 11 | 5% |
| other | 16 | 7% |

Simple parts build far better than big assemblies:

| Bucket | built | passes publish gate |
|---|---:|---:|
| popular | 54% | 29% |
| known | 59% | 31% |
| modest | 89% | 74% |
| long-tail | 87% | 64% |

The popular repos are multi-file products (Prusa i3, Framework Laptop, BOSL2) with heavy library
dependencies and slow CSG. The modest and long-tail repos are individual functional parts — which
is exactly the initial niche the brief recommended. **The audit independently confirms the niche
choice.**

### The annotation gap — the finding that changes the plan

Of the 167 that built, 112 (67%) expose at least one parameter. Across those, **1,058 parameters**:

| | n | % |
|---|---:|---:|
| with a range or dropdown annotation | 20 | **2%** |
| with a description comment | 216 | 20% |
| parts where every parameter is annotated | 1 of 112 | 1% |

Median parameters per part: **8**.

This is the important result, and it contradicts the brief. Datum's core wager was that reading
OpenSCAD's existing Customizer syntax makes publishing free, because authors have already done the
work. **They have not.** Real parametric source is a wall of bare top-level assignments.

It is not fatal — a parameter with no annotation still renders as a number box, so the configurator
works. But the *polished* experience, the sliders and dropdowns that make the demo compelling, is
present in 4% of parts rather than most of them.

### What could actually be imported today

| Filter | n |
|---|---:|
| candidate parts sampled | 238 |
| builds | 167 |
| builds **and** passes the publish gate | 112 |
| ...**and** carries a clear licence | **55** (from 17 repos) |
| ...**and** has any annotated parameter | 2 |

**Roughly one in four** real-world OpenSCAD files that look like parts could be imported today. At
that yield, ~400 repositories would produce ~500 parts — well within reach of the harness now built.

Licensing is worse than expected: 128 of 238 (54%) have no licence or `NOASSERTION`. The most common
actual licence is GPL-3.0 (49), whose application to hardware designs is legally murky.

### Publish-gate blockers

Among all 238 sampled: 90 blocked on *"has configurable parameters"* and 71 on *"compiles to
geometry"*. That first number is worth sitting with — **a third of files that look like parts are
hardcoded models with no parameters at all.** They are meshes in source form, and the gate correctly
refuses them. The gate is doing real work rather than waving everything through.

## What this changes

1. **Ship library dependency resolution.** 69% of failures involve an unresolved include, and the
   same handful of libraries (BOSL2, dotSCAD, NopSCADlib, Round-Anything, threads.scad) account for
   most of them. Vendoring a small set of known libraries into the build sandbox — or resolving them
   as declared dependencies — moves the build rate from 70% to about 91%. Nothing else on the
   roadmap has that leverage.

2. **Assisted annotation becomes a core feature, not a nicety.** Since authors do not annotate,
   Datum has to help. Given `wall = 2.4;` it can propose a plausible range and a widget, show the
   author the resulting configurator, and let them accept with one click. This turns the annotation
   gap from an obstacle into the clearest reason to publish here rather than on GitHub — *"we turned
   your 8 raw variables into a real interface."* It also makes the existing readiness warnings
   actionable instead of merely accusatory.

3. **Reduce timeouts, or make them explicit.** 6% exceeded 25 s. Some are genuinely heavy CSG. A
   longer budget for a one-off publish build, with a shorter one for interactive configuration, is
   the obvious split.

4. **Do not plan on scraped seeding alone.** 55 importable parts from 44 repos, of which 2 have a
   good configurator. Seeding fills the shelves; it does not produce a compelling front page. The
   concierge and interview work from the validation plan still has to happen.

## Follow-up: library resolution, and a defect it exposed

Acting on finding 1 (resolve library dependencies) produced a result worth recording, because the
naive reading of it is wrong.

Two mechanisms were added: search paths derived from the part's own files, and a small vendored
library set (BOSL2, Round-Anything, MCAD) pinned to immutable commits. Re-running the audit, the
measured build rate **fell from 70% to 50%**, and timeouts rose from 14 to 67.

That looks like a regression. It is not. Isolating the mechanism on a synthetic part:

| | `ok` | triangles | bounding box |
|---|---|---:|---|
| include unresolved | **true** | 12 | 10 × 10 × 10 |
| include resolved | true | 24 | **30 × 10 × 10** |

**A missing include does not fail the build.** OpenSCAD downgrades it to a warning, renders whatever
it still understands, and exits zero — producing a watertight solid that is materially the wrong
part. The original 70% therefore included an unknown number of silently incomplete builds that had
been scored as successes. Resolving includes makes those parts render in full, which is both more
correct and far more expensive, and the cost lands on a 25-second timeout.

So the honest conclusion is not "library resolution made things worse". It is:

1. **The earlier 70% was optimistic**, because a partial model counted as a success.
2. **Compute time, not include resolution, is now the binding constraint.**
3. **The publish gate had a real defect.** A build that silently drops geometry is now reported as a
   failure with a specific reason — the missing file or the unknown module is named — rather than
   published with a healthy-looking dimension report. This is the single most valuable thing the
   audit produced, and it would never have surfaced from source written in-house.

## Limitations

- One kernel version (OpenSCAD 2021.01, Debian bookworm). A newer release would build more.
- GitHub only, and only repos GitHub labels `language:OpenSCAD`. Parts published on Printables or
  Thingiverse as bare `.scad` attachments are not represented, and may be *more* annotated, since
  Thingiverse Customizer was the reason that syntax exists.
- 39 of 238 builds had files dropped by a 400 KB per-file cap; those built at 44% versus 75% for
  clean runs, so the true rate is likely nearer 75%.
- The static classifier has false positives: some library files call a demo module at the top level
  and were compiled as parts. This depresses the measured build rate rather than inflating it.
- Sampling up to 12 files per repo means large repos are under-represented relative to their size.
  That is deliberate — otherwise BOSL2 alone would dominate the result.

## Bugs this found

Running real source through the product immediately found two defects, both now fixed:

- **Filenames with spaces were rejected outright.** The builder and the publish API both validated
  filenames against a character whitelist, so `Tooling/Steady Rest.scad` produced a 400 and took the
  whole part down with it. 26 of the first run's results were this bug rather than a real outcome.
  Replaced with a path-containment check, which is simultaneously more permissive and stricter.
- **Nested entry files could not build.** The builder always wrote the entry as `main.scad` at the
  root, so a part whose source lived in a subdirectory could not resolve `../lib/x.scad`. The build
  request now takes an `entry` path and preserves the original layout.
