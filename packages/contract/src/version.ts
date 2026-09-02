/**
 * The wire-contract version advertised at `GET /health` and used for semver
 * negotiation between the platform and a deployed connector. This is the
 * *protocol* version, deliberately independent of this package's npm version
 * (`package.json`): the npm package may be republished for a docs or build fix
 * without the wire format changing. Frozen for v1: bumping the major here is a
 * contract release — every deployed connector must redeploy — not a commit.
 */
export const CONTRACT_VERSION = '1.0.0';

export interface ContractVersionInfo {
  version: string; // e.g. "1.0.0"
  releasedAt: string; // ISO date
  supportedUntil: string | null; // null while this is the current major
}

/** D10: 12 months of support from the day the NEXT major ships. */
export function computeSupportedUntil(nextMajorReleasedAt: string): string {
  const d = new Date(nextMajorReleasedAt);
  d.setDate(d.getDate() + 365);
  return d.toISOString();
}
