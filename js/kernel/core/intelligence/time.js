/**
 * Local time for the intelligence domain (#7, "Categories and time"). Domain code never reads
 * the host's clock or time zone: it takes an instant from an injected clock and the user's
 * IANA time zone, and works out local dates and local midnights here, through ECMAScript's
 * Intl, so a category is the same on every machine and across a DST change. The baseline
 * Popup's UTC "today" was the bug this replaces.
 *
 * A local date is `YYYY-MM-DD`. A floating date (a signal's `dueDate`) is one of these with no
 * time zone of its own: it's due on that date wherever the user is.
 */

/** `YYYY-MM-DD`, a real calendar date */
export const LOCAL_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/**
 * The formatter that reads an instant's wall-clock fields in `timeZone`
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatIn(timeZone) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(timeZone, format);
  }
  return format;
}

/**
 * Whether `timeZone` is an IANA time zone this runtime knows
 * @param {unknown} timeZone
 * @returns {timeZone is string}
 */
export function isTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    formatIn(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} date
 * @returns {date is string}
 */
export function isLocalDate(date) {
  if (typeof date !== 'string' || !LOCAL_DATE.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const back = new Date(Date.UTC(year, month - 1, day));
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day;
}

/**
 * The wall-clock fields of `instant` in `timeZone`
 * @param {number} instant
 * @param {string} timeZone
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}
 */
export function wallClock(instant, timeZone) {
  /** @type {Record<string, number>} */
  const fields = {};
  for (const part of formatIn(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

/**
 * How far `timeZone` is ahead of UTC at `instant`, in milliseconds
 * @param {number} instant
 * @param {string} timeZone
 * @returns {number}
 */
function offsetAt(instant, timeZone) {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * @param {number} value
 * @param {number} width
 */
const pad = (value, width) => String(value).padStart(width, '0');

/**
 * The local date `instant` falls on in `timeZone`
 * @param {number} instant
 * @param {string} timeZone
 * @returns {string}
 */
export function localDateOf(instant, timeZone) {
  const { year, month, day } = wallClock(instant, timeZone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * The local date `days` after `date` (before it, when negative)
 * @param {string} date
 * @param {number} days
 * @returns {string}
 */
export function addLocalDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1, 2)}-${pad(moved.getUTCDate(), 2)}`;
}

/**
 * How many local days `to` is after `from`
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function localDaysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * The instant the local wall-clock time `hour:minute` on `date` happens in `timeZone`. A time
 * a DST change repeats resolves to the first of the two, and one it skips moves forward by the
 * gap, as Temporal's `compatible` disambiguation does: a skipped midnight is the day's first
 * instant.
 * @param {string} date
 * @param {string} timeZone
 * @param {number} [hour]
 * @param {number} [minute]
 * @returns {number}
 */
export function instantAt(date, timeZone, hour = 0, minute = 0) {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Each offset the zone has within a day of the wall time: one, or two around a change
  const candidates = [
    ...new Set([
      offsetAt(wall - 86_400_000, timeZone),
      offsetAt(wall, timeZone),
      offsetAt(wall + 86_400_000, timeZone),
    ]),
  ]
    .map(offset => wall - offset)
    .filter(instant => {
      const back = wallClock(instant, timeZone);
      return Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute) === wall;
    })
    .sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0];
  // In a gap the wall time never happens: read it in the offset from before the change
  return wall - offsetAt(wall - 86_400_000, timeZone);
}

/**
 * The instant `days` local days after `instant` in `timeZone`, at the same wall-clock time, so
 * 14 days after 09:00 is 09:00 whether or not a DST change falls between
 * @param {number} instant
 * @param {number} days
 * @param {string} timeZone
 * @returns {number}
 */
export function addLocalDaysToInstant(instant, days, timeZone) {
  const target = instant + days * 86_400_000;
  return target + (offsetAt(instant, timeZone) - offsetAt(target, timeZone));
}

/**
 * The instant local `date` starts in `timeZone`
 * @param {string} date
 * @param {string} timeZone
 * @returns {number}
 */
export function startOfLocalDay(date, timeZone) {
  return instantAt(date, timeZone, 0, 0);
}
