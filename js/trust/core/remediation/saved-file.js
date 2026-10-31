/**
 * "Saved" as the Trust and Recovery Center means it (#20, "Remediation pipeline"; the owner's
 * "no false success states"): a file written through `showSaveFilePicker()` with its stream's
 * `close()` resolved, then read back from the same handle, parsed, and counted, store by
 * store, against what was built. Anything less answers not saved:
 * - `picker-unavailable`: the page has no picker, or it threw (as it does once the click's
 *   activation has run out). Nothing falls back to an anchor or Utils.downloadFile download,
 *   which can't say whether a file landed.
 * - `cancelled`: the user closed the picker, which isn't a failure: the run goes back to its
 *   preview.
 * - `build-failed` (or the reader's own code): the file couldn't be built once picked.
 * - `file-not-saved`: the write or the close failed.
 * - `file-unreadable`: the file wouldn't read back, or didn't parse.
 * - `file-mismatch`: it parsed, but its counts, or its length in characters, aren't what was
 *   built.
 *
 * The picker comes first, before anything is read: `showSaveFilePicker` needs the click's
 * transient activation, which runs out a few seconds after the click, and reading a large
 * profile takes longer than that. The file is built only once the user picked where it goes.
 *
 * Memory: what's being saved is held once, as the reader read it. It's written part by part,
 * each store row, legacy-copy row, and recovery-point row its own JSON.stringify, made as the
 * write takes it, so no string holds more than one record while writing. The built file is
 * dropped before the read-back. The read-back does hold the whole file, once as the string
 * File.text() gives and once parsed, since the counts come from a parse; streaming that is
 * left for when a profile's size calls for it.
 */

import { RUN_OUTCOMES } from '../codes.js';
import { countFile, readOf } from './salvage-file.js';

/** @typedef {import('./ports.js').FilePort} FilePort */
/** @typedef {import('./salvage-file.js').FileCounts} FileCounts */
/** @typedef {import('./salvage-file.js').Unreadable} Unreadable */

/**
 * What a built file read, for the run's answer
 * @typedef {ReturnType<typeof readOf>} FileRead
 */

/**
 * A file written and closed, not yet read back
 * @typedef {{status: 'written', handle: unknown, characters: number, counts: FileCounts, read: FileRead}} Written
 */

/**
 * @typedef {{status: 'saved', counts: FileCounts, characters: number, read: FileRead}
 *   | {status: 'cancelled'}
 *   | {status: 'failed', code: string, picked?: true}} SaveResult
 */

/**
 * Whether `value` is an object `{}` or a parse made, whose fields JSON writes as they are
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlain = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Whether JSON leaves a field holding `value` out
 * @param {unknown} value
 */
const omitted = value => value === undefined || typeof value === 'function' || typeof value === 'symbol';

/**
 * An array's JSON, one part per item, each item through `each`
 * @param {readonly unknown[]} list
 * @param {(item: unknown) => Iterable<string>} each
 * @returns {Generator<string>}
 */
function* listParts(list, each) {
  yield '[';
  for (let index = 0; index < list.length; index++) {
    if (index > 0) yield ',';
    yield* each(omitted(list[index]) ? null : list[index]);
  }
  yield ']';
}

/**
 * A value's JSON: an array one record per part, and a plain object field by field down
 * `depth` more levels, anything else whole
 * @param {unknown} value
 * @param {number} depth
 * @returns {Generator<string>}
 */
function* valueParts(value, depth) {
  if (Array.isArray(value)) yield* listParts(value, item => [JSON.stringify(item)]);
  else if (isPlain(value) && depth > 0) yield* objectParts(value, depth);
  else yield JSON.stringify(value);
}

/**
 * A plain object's JSON, field by field
 * @param {Record<string, unknown>} value
 * @param {number} depth
 * @returns {Generator<string>}
 */
function* objectParts(value, depth) {
  yield '{';
  let first = true;
  for (const [key, item] of Object.entries(value)) {
    if (omitted(item)) continue;
    yield `${first ? '' : ','}${JSON.stringify(key)}:`;
    first = false;
    yield* valueParts(item, depth - 1);
  }
  yield '}';
}

/**
 * `file` as JSON in parts, made as they're taken: each record its own part, wherever it is,
 * in a top-level list, under `stores` or `unimportable`, in a legacy copy, or in a recovery
 * point's rows. The parts joined are JSON.stringify(file) exactly.
 * @param {Record<string, unknown>} file
 * @returns {Generator<string>}
 */
export function* serialize(file) {
  yield '{';
  let first = true;
  for (const [key, value] of Object.entries(file)) {
    if (omitted(value)) continue;
    yield `${first ? '' : ','}${JSON.stringify(key)}:`;
    first = false;
    // A point is a record of records: its rows go out one at a time too
    if (key === 'recoveryPoints' && Array.isArray(value)) {
      yield* listParts(value, point => (isPlain(point) ? objectParts(point, 2) : [JSON.stringify(point)]));
    } else {
      yield* valueParts(value, 3);
    }
  }
  yield '}';
}

/**
 * Whether two count lists are the same, store by store
 * @param {FileCounts} a
 * @param {FileCounts} b
 */
export function sameCounts(a, b) {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && a[key] === b[key]);
}

/**
 * The code a build that threw answers: its own registered one, or `build-failed`
 * @param {unknown} error
 */
const buildCode = error => {
  const code = error && typeof error === 'object' ? /** @type {{code?: unknown}} */ (error).code : undefined;
  return typeof code === 'string' && /** @type {readonly string[]} */ (RUN_OUTCOMES).includes(code)
    ? code
    : 'build-failed';
};

/**
 * The first half of a save: the picker, then the file built, then the write, resolved once
 * the stream's close() has. A remediation whose action is the save runs this as its apply.
 * @param {{files: FilePort | undefined, suggestedName: string, build: () => Promise<Record<string, unknown> & {counts: FileCounts}>, subjectId?: string | null}} options - `subjectId`: what the file must hold, for an irreversible run's recovery file
 * @returns {Promise<Written | {status: 'cancelled'} | {status: 'failed', code: string, picked?: true}>}
 */
export async function writeFile({ files, suggestedName, build, subjectId = null }) {
  if (!files || !files.available()) return { status: 'failed', code: 'picker-unavailable' };
  /** @type {unknown} */
  let handle;
  try {
    handle = await files.pick({ suggestedName });
  } catch {
    return { status: 'failed', code: 'picker-unavailable' };
  }
  if (handle === null || handle === undefined) return { status: 'cancelled' };
  /** @type {(Record<string, unknown> & {counts: FileCounts}) | null} */
  let file;
  try {
    file = await build();
  } catch (error) {
    return { status: 'failed', code: buildCode(error), picked: true };
  }
  const { counts } = file;
  const read = readOf(/** @type {Record<string, unknown>} */ (file), subjectId);
  let characters = 0;
  const parts = serialize(file);
  file = null;
  /** @returns {Generator<string>} */
  function* counted() {
    for (const part of parts) {
      characters += part.length;
      yield part;
    }
  }
  try {
    await files.write(handle, counted());
  } catch {
    return { status: 'failed', code: 'file-not-saved', picked: true };
  }
  return { status: 'written', handle, characters, counts, read };
}

/**
 * The second half: the file read back from the same handle, parsed, and counted against what
 * was built. A remediation whose action is the save runs this as its verify.
 * @param {{files: FilePort | undefined, written: Written}} options
 * @returns {Promise<{status: 'saved', counts: FileCounts, characters: number, read: FileRead} | {status: 'failed', code: 'file-unreadable' | 'file-mismatch'}>}
 */
export async function readBack({ files, written }) {
  if (!files) return { status: 'failed', code: 'file-unreadable' };
  /** @type {unknown} */
  let parsed;
  /** @type {unknown} */
  let text;
  try {
    text = await files.read(written.handle);
    parsed = JSON.parse(/** @type {string} */ (text));
  } catch {
    return { status: 'failed', code: 'file-unreadable' };
  }
  const length = typeof text === 'string' ? text.length : -1;
  text = null;
  const recounted = countFile(parsed);
  const stated =
    parsed !== null && typeof parsed === 'object' ? /** @type {{counts?: unknown}} */ (parsed).counts : null;
  const statedCounts =
    stated !== null && typeof stated === 'object' && !Array.isArray(stated) ? /** @type {FileCounts} */ (stated) : {};
  if (
    length !== written.characters ||
    !sameCounts(recounted, written.counts) ||
    !sameCounts(statedCounts, written.counts)
  ) {
    return { status: 'failed', code: 'file-mismatch' };
  }
  return { status: 'saved', counts: recounted, characters: written.characters, read: written.read };
}

/**
 * Saves the file `build` makes through the picker, and proves it (see the top of this file):
 * what an irreversible run's recovery file goes through before it may apply
 * @param {{files: FilePort | undefined, suggestedName: string, build: () => Promise<Record<string, unknown> & {counts: FileCounts}>, subjectId?: string | null}} options
 * @returns {Promise<SaveResult>}
 */
export async function saveVerified({ files, suggestedName, build, subjectId = null }) {
  const written = await writeFile({ files, suggestedName, build, subjectId });
  if (written.status !== 'written') return written;
  return readBack({ files, written });
}
