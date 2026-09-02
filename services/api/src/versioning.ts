import type { SchemaDiff } from "@datum/scad-schema";

/**
 * Proposing the next version number.
 *
 * Datum's semver is fit-based, as set out in the product brief:
 *
 *   major - mating surfaces moved; downstream parts may no longer fit
 *   minor - new capability, still fits
 *   patch - a fix with no interface change
 *
 * Authors reliably get this wrong when left to remember it, so the registry
 * proposes the bump from evidence: the schema diff (the part's public interface)
 * and the measured geometry of the default build.
 *
 * Honest limitation: OpenSCAD emits meshes, not B-rep, so we cannot identify
 * individual mating faces. Geometry evidence here is whole-part -- bounding box
 * and volume. That catches "this got bigger" but not "the bolt circle rotated
 * 5 degrees while the envelope stayed identical". The proposal is always
 * presented as a proposal, never applied silently, and the caveat travels with
 * it so nobody mistakes it for a fit analysis.
 */

export type Bump = "major" | "minor" | "patch";

export interface GeometrySummary {
  boundingBox: { size: [number, number, number] };
  volumeMm3: number;
  solid: boolean;
}

export interface BumpReason {
  level: Bump;
  message: string;
}

export interface BumpProposal {
  bump: Bump;
  /** The proposed next version string. */
  version: string;
  previousVersion: string;
  reasons: BumpReason[];
  /** Always present: what this analysis cannot see. */
  caveat: string;
  /** Minimum version the author is allowed to publish, given the evidence. */
  minimum: string;
}

/** Dimensional tolerance below which a bounding-box change is noise, in mm. */
const SIZE_EPSILON = 1e-3;
/** Relative volume change treated as noise (tessellation jitter). */
const VOLUME_EPSILON = 1e-4;

const CAVEAT =
  "Geometry is compared at the whole-part level (bounding box and volume). " +
  "OpenSCAD produces meshes rather than B-rep solids, so a change that moves a " +
  "mating feature without changing the overall envelope will not be detected here. " +
  "Check the fit yourself before releasing.";

export class InvalidVersionError extends Error {}

export function parseVersion(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new InvalidVersionError(`Not a valid version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function applyBump(version: string, bump: Bump): string {
  const [major, minor, patch] = parseVersion(version);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Is `candidate` strictly greater than `current`? */
export function isAfter(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

export function proposeBump(
  previousVersion: string,
  diff: SchemaDiff,
  previous: GeometrySummary | null,
  next: GeometrySummary | null,
): BumpProposal {
  const reasons: BumpReason[] = [];

  for (const name of diff.removed) {
    reasons.push({
      level: "major",
      message: `Parameter "${name}" was removed; saved configurations that set it will be rejected.`,
    });
  }
  for (const name of diff.added) {
    reasons.push({ level: "minor", message: `Parameter "${name}" was added.` });
  }
  for (const change of diff.changed) {
    reasons.push({
      level: change.severity === "breaking" ? "major" : change.severity === "additive" ? "minor" : "patch",
      message: `${change.name}: ${change.detail} (${change.from} → ${change.to})`,
    });
  }

  // Geometry evidence is only conclusive when the inputs did not move. If a
  // default changed, the two default builds were made from different parameters,
  // so a size difference says nothing about whether the part still fits.
  const defaultsMoved = diff.changed.some((c) => c.kind === "default");

  if (previous && next) {
    if (defaultsMoved) {
      reasons.push({
        level: "patch",
        message:
          "Geometry was not compared: a default value changed, so the two default builds are not the same configuration.",
      });
    } else {
      const grew = previous.boundingBox.size.some(
        (v, i) => Math.abs(v - next.boundingBox.size[i]!) > SIZE_EPSILON,
      );
      if (grew) {
        reasons.push({
          level: "major",
          message:
            `The default build's envelope changed from ` +
            `${previous.boundingBox.size.map(round).join(" × ")} to ` +
            `${next.boundingBox.size.map(round).join(" × ")} mm, so it may no longer fit where the old one did.`,
        });
      } else {
        const relative =
          Math.abs(next.volumeMm3 - previous.volumeMm3) / Math.max(Math.abs(previous.volumeMm3), 1);
        if (relative > VOLUME_EPSILON) {
          reasons.push({
            level: "minor",
            message:
              `The envelope is unchanged but the volume moved by ${(relative * 100).toFixed(2)}% ` +
              `(${round(previous.volumeMm3)} → ${round(next.volumeMm3)} mm³), so internal geometry changed.`,
          });
        }
      }
    }

    if (previous.solid && !next.solid) {
      reasons.push({
        level: "major",
        message: "The default build is no longer a closed solid; this is a regression, not a release.",
      });
    }
  }

  const bump: Bump = reasons.reduce<Bump>(
    (worst, r) => (RANK[r.level] > RANK[worst] ? r.level : worst),
    "patch",
  );

  if (reasons.length === 0) {
    reasons.push({
      level: "patch",
      message: "No interface or geometry change detected. Publish as a patch if the source changed at all.",
    });
  }

  const version = applyBump(previousVersion, bump);
  return {
    bump,
    version,
    previousVersion,
    reasons,
    caveat: CAVEAT,
    // The author may release something larger than proposed (a major when we
    // said minor is their call) but never smaller: the evidence is a floor.
    minimum: version,
  };
}

function round(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Is the author's chosen version acceptable given the proposal? */
export function checkChosenVersion(
  chosen: string,
  proposal: BumpProposal,
): { ok: true } | { ok: false; message: string } {
  let parsed: [number, number, number];
  try {
    parsed = parseVersion(chosen);
  } catch {
    return { ok: false, message: `"${chosen}" is not a valid version. Use major.minor.patch.` };
  }

  if (!isAfter(chosen, proposal.previousVersion)) {
    return {
      ok: false,
      message: `Version ${chosen} is not after the current release ${proposal.previousVersion}.`,
    };
  }

  const [prevMajor, prevMinor] = parseVersion(proposal.previousVersion);
  const [major, minor] = parsed;
  const chosenBump: Bump = major > prevMajor ? "major" : minor > prevMinor ? "minor" : "patch";

  if (RANK[chosenBump] < RANK[proposal.bump]) {
    return {
      ok: false,
      message:
        `This revision needs at least a ${proposal.bump} bump (${proposal.version}), ` +
        `but ${chosen} is a ${chosenBump}. ` +
        proposal.reasons.find((r) => r.level === proposal.bump)!.message,
    };
  }

  return { ok: true };
}
