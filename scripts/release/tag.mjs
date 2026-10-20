/**
 * Release tags, shared by check-version.mjs and is-latest.mjs. A release tag is `v` plus
 * MAJOR.MINOR.PATCH, each part a number from 0 to 65535 with no leading zero, so both npm
 * and Chrome accept the version.
 */

const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Chrome's limit for each part of a manifest version
const MAX_PART = 65535;

export const TAG_FORM = `v<major>.<minor>.<patch>, each part 0 to ${MAX_PART} with no leading zero, for example v1.4.1`;

/**
 * The version a release tag names, or null when the tag isn't one
 */
export function versionFromTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match || match.slice(1).some(part => Number(part) > MAX_PART)) return null;
  return tag.slice(1);
}

/**
 * Compare two versions from versionFromTag part by part: negative when a is lower,
 * 0 when equal, positive when a is higher
 */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}
