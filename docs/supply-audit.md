# Supply audit — September 2026

**Question.** The product brief named one kill criterion: *if most real-world parametric source
will not build unattended, geometry CI is a fantasy and the whole differentiator collapses.*
Everything built so far had been validated against source I wrote myself, which is the friendliest
possible input. This measures the unfriendly case.

**Answer.** The thesis survives. Two of its supporting assumptions do not, and the audit found a
defect that would have shipped wrong parts to real people.

- **60% of candidate parts build completely and honestly.** Geometry CI works on real code.
- **14% of parts that produced geometry were silently incomplete** — and 19 of those 23 were
  watertight, so the dimension report looked perfectly healthy. Datum would have published a part
  with pieces missing and a green badge on it. This is the most valuable thing the audit produced.
- **Only 2% of parameters carry a Customizer annotation.** The "authors already annotated their
  parameters, so a configurator is free" assumption is false at scale.
- **Compute time is the binding constraint**, not include resolution: raising the build budget from
  25 s to 90 s cut timeouts from 28% to 8%.

> **A note on the numbers.** An earlier pass reported 70%. That figure was wrong — it counted
> silently incomplete builds as successes, for the reason set out under *The defect* below. Every
> figure here is from the final run, with include resolution and the incompleteness gate in place.

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
| **built completely** | 142 | **60%** |
| missing include — geometry would have been dropped | 39 | 16% |
| still exceeds 90 s | 19 | 8% |
| syntax error | 12 | 5% |
| assertion rejected the defaults | 2 | 1% |
| unknown name | 2 | 1% |
| other (non-zero exit, no geometry) | 22 | 9% |

Simple parts build far better than big assemblies:

| Bucket | built | passes publish gate |
|---|---:|---:|
| popular | 36% | 15% |
| known | 47% | 22% |
| modest | 80% | 63% |
| long-tail | 85% | 61% |

The popular repos are multi-file products (Prusa i3, Framework Laptop, BOSL2) with heavy library
dependencies and slow CSG. The modest and long-tail repos are individual functional parts — which
is exactly the initial niche the brief recommended. **The audit independently confirms the niche
choice.**

### The defect: a missing include does not fail the build

OpenSCAD downgrades an unresolvable `include <>` to a warning, renders whatever it still
understands, and exits zero. Isolated on a synthetic part:

| | `ok` | triangles | bounding box |
|---|---|---:|---|
| include unresolved | **true** | 12 | 10 × 10 × 10 |
| include resolved | true | 24 | **30 × 10 × 10** |

In the corpus, **23 of 168 parts that produced any geometry (14%) were missing pieces**, and **19 of
those 23 were watertight closed solids**. A registry whose entire claim is "the build is the quality
gate" would have handed someone a keycap without its stem, with a healthy dimension report attached.

The gate now treats this as a build failure and names the missing file or unknown module. It is worth
noticing that this class of bug is invisible to any amount of testing against source you wrote
yourself — it only appears when you run other people's code.

### Build cost

| | |
|---|---|
| median | 3.7 s |
| p90 | 28.6 s |
| under 5 s | 58% |
| under 25 s | 86% |

A single budget cannot serve both an interactive configure and a one-off publish. 86% of parts fit
comfortably in an interactive budget; the remaining 14% need a publish-time budget several times
larger.

### The annotation gap

Of the 142 that built, 89 (63%) expose at least one parameter. Across the corpus, **1,058
parameters**:

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
| builds completely | 142 |
| builds **and** passes the publish gate | 89 |
| ...**and** carries a clear licence | ~45 |
| ...**and** has any annotated parameter | 2 |

**Roughly one in five** real-world OpenSCAD files that look like parts could be imported today. At
that yield, ~500 repositories would produce ~500 parts — within reach of the harness now built.

Licensing is worse than expected: 128 of 238 (54%) have no licence or `NOASSERTION`. The most common
actual licence is GPL-3.0 (49), whose application to hardware designs is legally murky.

### Publish-gate blockers

Among all 238 sampled: 90 blocked on *"has configurable parameters"* and 71 on *"compiles to
geometry"*. That first number is worth sitting with — **a third of files that look like parts are
hardcoded models with no parameters at all.** They are meshes in source form, and the gate correctly
refuses them. The gate is doing real work rather than waving everything through.

## What this changed

Three of these are **done**; they were built in response to this audit.

1. ~~**Fail silently-incomplete builds.**~~ **Done.** The highest-value fix, and the one that would
   never have been found without running strangers' code.

2. ~~**Resolve includes.**~~ **Done.** Search paths from the part's own files — most unresolved
   includes turned out to be projects expecting to be *installed*, not third-party libraries — plus
   a small vendored set (BOSL2, Round-Anything, MCAD) pinned to immutable commits, with the set's
   digest folded into every build hash so bumping one invalidates cached geometry.

3. ~~**Assisted annotation.**~~ **Done.** Datum proposes ranges from the parameter's name and
   default; the author reviews and accepts, and accepted ranges are written back as ordinary
   Customizer comments. This turns the annotation gap into the clearest answer to *"why publish here
   rather than on GitHub"*.

4. **Split the build budget.** Still to do. 86% of parts build in under 25 s; the rest need a much
   larger publish-time budget. One timeout cannot serve both an interactive configure and a publish.

5. **Do not plan on scraped seeding alone.** ~45 importable parts from 44 repos, of which 2 have a
   good configurator out of the box. Seeding fills the shelves; it does not produce a compelling
   front page. The concierge and interview work from the validation plan still has to happen.

## Limitations

- One kernel version (OpenSCAD 2021.01, Debian bookworm). A newer release would build more.
- GitHub only, and only repos GitHub labels `language:OpenSCAD`. Parts published on Printables or
  Thingiverse as bare `.scad` attachments are not represented, and may be *more* annotated, since
  Thingiverse Customizer was the reason that syntax exists.
- 39 of 238 builds had files dropped by a 400 KB per-file cap, which depresses their build rate.
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
