/**
 * The curated licence list.
 *
 * The brief is explicit that licensing is mandatory at publish and never a
 * free-text field: hardware sharing sites are full of "free to use but don't
 * sell" strings that mean nothing legally and cannot be checked by a machine.
 * A short list of real licences, each with a plain-language summary, is worth
 * more than a text box.
 *
 * `commercialUse` and `derivatives` are what the fork-time compatibility warning
 * will read once forking exists.
 */

export interface License {
  id: string;
  name: string;
  url: string;
  summary: string;
  commercialUse: boolean;
  derivatives: "yes" | "share-alike" | "no";
  /** Recommended for most parts, shown first. */
  recommended?: boolean;
}

export const LICENSES: License[] = [
  {
    id: "CC0-1.0",
    name: "CC0 1.0 (public domain)",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    summary: "Anyone may use this for anything, with no conditions and no attribution required.",
    commercialUse: true,
    derivatives: "yes",
  },
  {
    id: "CC-BY-4.0",
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    summary: "Anyone may use, modify and sell this, as long as they credit you.",
    commercialUse: true,
    derivatives: "yes",
    recommended: true,
  },
  {
    id: "CC-BY-SA-4.0",
    name: "CC BY-SA 4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    summary: "Credit you, and share any modified version under this same licence.",
    commercialUse: true,
    derivatives: "share-alike",
  },
  {
    id: "CC-BY-NC-4.0",
    name: "CC BY-NC 4.0",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
    summary: "Credit you, and no commercial use. Note that this is not an open licence.",
    commercialUse: false,
    derivatives: "yes",
  },
  {
    id: "MIT",
    name: "MIT",
    url: "https://opensource.org/license/mit",
    summary: "Permissive and familiar. Written for software, but common for CAD-as-code.",
    commercialUse: true,
    derivatives: "yes",
    recommended: true,
  },
  {
    id: "Apache-2.0",
    name: "Apache 2.0",
    url: "https://www.apache.org/licenses/LICENSE-2.0",
    summary: "Permissive, with an explicit patent grant. Sensible for functional hardware.",
    commercialUse: true,
    derivatives: "yes",
  },
  {
    id: "CERN-OHL-S-2.0",
    name: "CERN OHL-S v2",
    url: "https://cern-ohl.web.cern.ch/",
    summary: "Strongly reciprocal, and written for hardware rather than adapted from software.",
    commercialUse: true,
    derivatives: "share-alike",
  },
  {
    id: "CERN-OHL-P-2.0",
    name: "CERN OHL-P v2",
    url: "https://cern-ohl.web.cern.ch/",
    summary: "Permissive hardware licence from the same family.",
    commercialUse: true,
    derivatives: "yes",
  },
  {
    id: "ARR",
    name: "All rights reserved",
    url: "",
    summary:
      "Viewing and configuring only. Nobody may redistribute or modify this without asking you first.",
    commercialUse: false,
    derivatives: "no",
  },
];

const BY_ID = new Map(LICENSES.map((l) => [l.id, l] as const));

export function isLicense(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

export function getLicense(id: string): License | undefined {
  return BY_ID.get(id);
}
