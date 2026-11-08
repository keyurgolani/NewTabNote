/**
 * Times as the trust pages say them (#20 slice 4c): local, as their rows show them, with no time
 * zone (the design review's change 14). recovery.html's views (model.js) and the status pages'
 * lines (status.js) read them here, so a time reads the same on every surface. It imports
 * nothing, so a status page loads it with its lines and no more.
 */

/** A time of day: 10:42 AM */
export const clockFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** A day: Oct 28 */
export const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The local day `at` falls on, as a string to compare
 * @param {number} at
 */
export const dayOf = at => new Date(at).toDateString();

/**
 * Inside a sentence: at 10:42 AM, yesterday at 7:02 PM, on Oct 28
 * @param {number} at
 * @param {number} now
 */
export function whenText(at, now) {
  if (dayOf(at) === dayOf(now)) return `at ${clockFormat.format(at)}`;
  if (dayOf(at) === dayOf(now - DAY_MS)) return `yesterday at ${clockFormat.format(at)}`;
  return `on ${dayFormat.format(at)}`;
}
