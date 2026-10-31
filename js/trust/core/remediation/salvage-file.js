/**
 * The salvage file and a restore point's file (#20, "Salvage file"; "Data and migration"):
 * what the salvage reader read (js/kernel/adapters/indexeddb/salvage-reader.js), shaped as
 * #17's legacy export, `{version: 1, exportedAt, canvases, elements, media, folders}`, so
 * 1.4.x's import (1.4.1's validateImport included) reads it, with everything else beside it
 * under keys 1.4.x ignores:
 * - `canvases`: every note outside trash, archived ones and templates included, as 1.4.1's
 *   own export holds them; `trashedCanvases` the trashed ones, since 1.4.1's import brings
 *   every note in out of trash.
 * - `elements`: those notes' blocks; `orphanElements` every other block, since 1.4.1 refuses
 *   a file with a block whose note isn't in it.
 * - `media`: every media row, Blobs as data URLs; 1.4.1 skips a row whose note isn't in the
 *   file. `folders`: every folder.
 * - `unimportable`: records 1.4.1 would refuse the whole file for (no text id, or an id two
 *   records share), kept rather than dropped.
 * - `stores`: every other known CanvasTabDB store, raw, by name.
 * - `legacyCopies` (salvage only): each `auto_backup_*` and `recovery_backup_*` copy, by key.
 * - `recoveryPoints` (salvage only): each #17 point with its kind, status, times, whether it
 *   reads back verified now, and its rows per store.
 * - `salvage: true` on the salvage file, and `restorePoint` on a restore point's file.
 * - `counts`: how many records the file holds per store, which the save checks the file it
 *   reads back against; `unreadable`: each source or store that wouldn't read, with its
 *   error code (a store that wouldn't read is written as `[]`), the same list the run answers
 *   with; `omissions`: what was left out and why.
 *
 * Only the stores CanvasTabDB is known to have go in (SALVAGE_STORES): one the schema doesn't
 * name, such as a future vault's, is left out and listed. Nothing secret goes in: never the
 * legacy IndexedDB `settings` store, which held the AI key in plaintext up to 1.1.2, never a
 * `settings` store inside a legacy copy, never a field named for a credential in any case or
 * spelling (isSecretField), and never a `{key, value}` row whose key names one. Each is listed
 * under `omissions` by where it was, never with its value.
 *
 * The salvage file has no `journal`: NewTabNoteJournal is #17's deferred capture journal, and
 * nothing writes one yet.
 */

import { RUN_OUTCOMES } from '../codes.js';
import { MAX_UNREADABLE, SALVAGE_ORIGINS, SALVAGE_STORES, unreadableSchema } from '../records.js';

// Where a salvage file reads from and which stores it holds live with the run record, which
// names them; they're this file's words
export { MAX_UNREADABLE, SALVAGE_ORIGINS, SALVAGE_STORES, unreadableSchema };

/**
 * @typedef {{store: string, values: unknown[], errorCode?: string}} StoreRead
 * @typedef {{id: string, kind: string, status: string, verified: boolean, createdAt: number, verifiedAt: number | null, stores: StoreRead[]}} PointRead
 * @typedef {object} SalvageRead
 * @property {{status: 'open' | 'missing' | 'failed', errorCode?: string, stores: StoreRead[]}} database
 * @property {{status: 'read' | 'failed', errorCode?: string, copies: Array<{key: string, value: unknown}>}} legacyCopies
 * @property {{status: 'read' | 'missing' | 'failed', errorCode?: string, points: PointRead[]}} recoveryPoints
 * @typedef {{kind: 'legacy-copy', key: string, value: unknown} | {kind: 'recovery-point', point: PointRead}} RestorePointRead
 */

/** @typedef {{what: 'store' | 'field' | 'row', at: string, reason: 'secret' | 'unknown-store' | 'unknown-field'}} Omission */

/** @typedef {Record<string, number>} FileCounts */

/**
 * A source or a store that wouldn't read: where, and its code. `part` is the store, null for
 * a whole source, and `pointId` the recovery point it's in, when it's in one.
 * @typedef {{origin: (typeof SALVAGE_ORIGINS)[number], part: (typeof SALVAGE_STORES)[number] | null, pointId: string | null, code: string}} Unreadable
 */

/** The CanvasTabDB store whose class is `secret` (#17's secret accessor): the legacy IndexedDB settings */
export const SECRET_STORES = Object.freeze(['settings']);

/**
 * Field names that hold a credential in some release, or could: the AI key and the WebDAV
 * config (its password) as chrome.storage.local and the legacy IndexedDB settings store them,
 * and any name for a password, a token, a secret, or an API key. Compared with case and
 * everything but letters and digits taken out, so `llmAPIKey` and `llm_api_key` match too.
 */
export const SECRET_FIELDS = Object.freeze([
  'llmapikey',
  'settingllmapikey',
  'syncwebdavconfig',
  'settingsyncwebdavconfig',
  'apikey',
  'password',
  'pass',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'credential',
  'credentials',
  'privatekey',
]);

/** Words that make any name a credential's, wherever they are in it */
const SECRET_WORDS = Object.freeze(['password', 'apikey', 'secret', 'passphrase', 'credential']);

/**
 * Whether `name` names a credential (see SECRET_FIELDS)
 * @param {string} name
 */
export function isSecretField(name) {
  const plain = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_FIELDS.includes(plain) || SECRET_WORDS.some(word => plain.includes(word))) return true;
  // Its words, camelCase and snake_case alike: `authToken` is auth, token
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = words[words.length - 1];
  if (words.some(word => SECRET_NAME_WORDS.includes(word))) return true;
  // A key named for what it opens: `openaiKey`, `accessKey`, `clientKey`
  return last === 'key' && words.length > 1 && KEY_KINDS.includes(words[words.length - 2]);
}

/** Words that name a credential on their own, as a whole word: `syncToken`, `webdavPass`, `pwd` */
const SECRET_NAME_WORDS = Object.freeze(['token', 'pass', 'passwd', 'pwd', 'bearer', 'auth', 'authorization']);

/** What a key that's a credential is the key to */
const KEY_KINDS = Object.freeze(['api', 'access', 'secret', 'private', 'openai', 'llm', 'client', 'session', 'signing']);

/** The keys a legacy export holds its records under, which 1.4.1 reads */
const LEGACY_KEYS = Object.freeze(['canvases', 'elements', 'media', 'folders']);

/**
 * The other CanvasTabDB stores a legacy copy can hold under their own names (#33's
 * missing-stores copy holds every readable store)
 */
const OTHER_STORES = Object.freeze(['search_index', 'links', 'themes', 'vectors', 'snapshots', 'meta', 'migrations']);

/** How deep a value is searched for a secret field */
const MAX_DEPTH = 32;

/** A #17 recovery point's id */
const POINT_ID = /^pre-(?:migration|repair)-[0-9]{10,16}(?:-[0-9]{1,3})?$/;

/**
 * Whether `value` is an object made by `{}` or a JSON parse
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether `value` is a settings row, `{key, value}`, whose key names a credential
 * @param {unknown} value
 */
const isSecretRow = value =>
  isObject(value) && typeof value.key === 'string' && 'value' in value && isSecretField(value.key);

/**
 * `value` with every secret field, and every settings row naming a credential, taken out,
 * deep, and where each was, appended to `omitted`
 * @param {unknown} value
 * @param {string} at
 * @param {Omission[]} omitted
 * @param {number} [depth]
 * @returns {unknown}
 */
export function withoutSecrets(value, at, omitted, depth = 0) {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    /** @type {unknown[]} */
    const kept = [];
    value.forEach((item, index) => {
      if (isSecretRow(item)) omitted.push({ what: 'row', at: `${at}[${index}]`, reason: 'secret' });
      else kept.push(withoutSecrets(item, `${at}[${index}]`, omitted, depth + 1));
    });
    return kept;
  }
  if (!isObject(value)) return value;
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretField(key)) {
      omitted.push({ what: 'field', at: `${at}.${key}`, reason: 'secret' });
      continue;
    }
    copy[key] = withoutSecrets(item, `${at}.${key}`, omitted, depth + 1);
  }
  return copy;
}

/**
 * A registered run outcome for an error code, or `fallback` for one this build doesn't know
 * @param {string | undefined} code
 * @param {string} fallback
 */
const readCode = (code, fallback) =>
  typeof code === 'string' && /** @type {readonly string[]} */ (RUN_OUTCOMES).includes(code) ? code : fallback;

/**
 * Whether 1.4.1's validateImport takes `record` as one of a list: an object with a text id
 * @param {unknown} record
 * @returns {record is {id: string} & Record<string, unknown>}
 */
const hasTextId = record => isObject(record) && typeof record.id === 'string' && record.id !== '';

/**
 * `records` split into those 1.4.1 takes (a text id, once) and the rest
 * @param {readonly unknown[]} records
 */
function importable(records) {
  /** @type {Array<{id: string} & Record<string, unknown>>} */
  const ok = [];
  /** @type {unknown[]} */
  const rest = [];
  const seen = new Set();
  for (const record of records) {
    if (hasTextId(record) && !seen.has(record.id)) {
      seen.add(record.id);
      ok.push(record);
    } else {
      rest.push(record);
    }
  }
  return { ok, rest };
}

/**
 * Notes, blocks, media, and folders as #17's legacy export holds them
 * @param {{notes: readonly unknown[], blocks: readonly unknown[], media: readonly unknown[], folders: readonly unknown[]}} records
 */
export function legacyShape({ notes, blocks, media, folders }) {
  const allNotes = importable(notes);
  const canvases = allNotes.ok.filter(note => !note.trashed);
  const trashedCanvases = allNotes.ok.filter(note => note.trashed);
  const exported = new Set(canvases.map(note => note.id));
  const allBlocks = importable(blocks);
  const allMedia = importable(media);
  const allFolders = importable(folders);
  return {
    canvases,
    elements: allBlocks.ok.filter(block => exported.has(/** @type {string} */ (block.canvasId))),
    media: allMedia.ok,
    folders: allFolders.ok,
    orphanElements: allBlocks.ok.filter(block => !exported.has(/** @type {string} */ (block.canvasId))),
    trashedCanvases,
    unimportable: {
      canvases: allNotes.rest,
      elements: allBlocks.rest,
      media: allMedia.rest,
      folders: allFolders.rest,
    },
  };
}

/**
 * How many records `file` holds per store: a legacy store's records wherever the file split
 * them (`canvases` with `trashedCanvases` and the unimportable ones, and so on), each other
 * store's under `stores`, and the legacy copies and recovery points. The save counts the file
 * it built and the file it reads back with this, and the two must match.
 * @param {unknown} file
 * @returns {FileCounts}
 */
export function countFile(file) {
  if (!isObject(file)) return {};
  /** @param {unknown} list */
  const length = list => (Array.isArray(list) ? list.length : 0);
  const unimportable = isObject(file.unimportable) ? file.unimportable : {};
  /** @type {FileCounts} */
  const counts = {
    canvases: length(file.canvases) + length(file.trashedCanvases) + length(unimportable.canvases),
    elements: length(file.elements) + length(file.orphanElements) + length(unimportable.elements),
    media: length(file.media) + length(unimportable.media),
    folders: length(file.folders) + length(unimportable.folders),
  };
  if (isObject(file.stores)) {
    for (const [store, list] of Object.entries(file.stores)) counts[`stores.${store}`] = length(list);
  }
  if (isObject(file.legacyCopies)) counts.legacyCopies = Object.keys(file.legacyCopies).length;
  if (Array.isArray(file.recoveryPoints)) {
    counts.recoveryPoints = file.recoveryPoints.length;
    let rows = 0;
    for (const point of file.recoveryPoints) {
      if (isObject(point) && isObject(point.stores)) {
        for (const list of Object.values(point.stores)) rows += length(list);
      }
    }
    counts.recoveryPointRows = rows;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The values each store read, by store: only the known stores, without the secret one and
 * without secret fields or rows, and each store that wouldn't read
 * @param {readonly StoreRead[]} stores
 * @param {string} at
 * @param {Omission[]} omitted
 * @param {{origin: Unreadable['origin'], pointId: string | null}} where
 */
function readStores(stores, at, omitted, where) {
  /** @type {Record<string, unknown[]>} */
  const values = {};
  /** @type {Unreadable[]} */
  const unreadable = [];
  for (const read of stores) {
    if (SECRET_STORES.includes(read.store)) {
      omitted.push({ what: 'store', at: `${at}.${read.store}`, reason: 'secret' });
      continue;
    }
    if (!(/** @type {readonly string[]} */ (SALVAGE_STORES).includes(read.store))) {
      omitted.push({ what: 'store', at: `${at}.${read.store}`, reason: 'unknown-store' });
      continue;
    }
    values[read.store] = /** @type {unknown[]} */ (withoutSecrets(read.values, `${at}.${read.store}`, omitted));
    if (read.errorCode) {
      unreadable.push({
        origin: where.origin,
        part: /** @type {Unreadable['part']} */ (read.store),
        pointId: where.pointId,
        code: readCode(read.errorCode, 'unreadable'),
      });
    }
  }
  return { values, unreadable };
}

/**
 * A legacy shape and the other stores, from stores read by name
 * @param {Record<string, unknown[]>} values
 */
function fromStores(values) {
  const shaped = legacyShape({
    notes: values.canvases || [],
    blocks: values.elements || [],
    media: values.media || [],
    folders: values.folders || [],
  });
  /** @type {Record<string, unknown[]>} */
  const stores = {};
  for (const [store, list] of Object.entries(values)) if (!LEGACY_KEYS.includes(store)) stores[store] = list;
  return { shaped, stores };
}

/**
 * The file: the legacy shape first, so 1.4.1 finds it, then the rest, then the counts
 * @param {Record<string, unknown>} body
 * @returns {Record<string, any> & {counts: FileCounts, unreadable: Unreadable[]}}
 */
function withCounts(body) {
  const counts = countFile(body);
  return /** @type {any} */ ({ ...body, counts });
}

/**
 * A whole source that wouldn't read
 * @param {Unreadable['origin']} origin
 * @param {string} code
 * @returns {Unreadable}
 */
const whole = (origin, code) => ({ origin, part: null, pointId: null, code });

/**
 * What a legacy copy may hold besides stores: the fields 1.4.x's exportAll, auto-backup, and
 * recovery copies write (#33's missing-stores copy included)
 */
const COPY_FIELDS = Object.freeze([
  'version',
  'exportedAt',
  'reason',
  'timestamp',
  'missingStores',
  'autoBackup',
  'backupCreatedAt',
  'recoveryBackup',
]);

/**
 * A legacy copy as a file keeps it: only the known stores and the known fields, without
 * secrets. The secret `settings` store, any other store (an array field), and any other field
 * are left out and listed.
 * @param {unknown} value
 * @param {string} at
 * @param {Omission[]} omitted
 * @returns {Record<string, unknown>}
 */
function keptCopy(value, at, omitted) {
  if (!isObject(value)) return {};
  /** @type {Record<string, unknown>} */
  const kept = {};
  for (const [field, item] of Object.entries(value)) {
    if (SECRET_STORES.includes(field)) omitted.push({ what: 'store', at: `${at}.${field}`, reason: 'secret' });
    else if (/** @type {readonly string[]} */ (SALVAGE_STORES).includes(field) && Array.isArray(item)) kept[field] = item;
    else if (COPY_FIELDS.includes(field)) kept[field] = item;
    else if (isSecretField(field)) omitted.push({ what: 'field', at: `${at}.${field}`, reason: 'secret' });
    else if (Array.isArray(item)) omitted.push({ what: 'store', at: `${at}.${field}`, reason: 'unknown-store' });
    else omitted.push({ what: 'field', at: `${at}.${field}`, reason: 'unknown-field' });
  }
  return /** @type {Record<string, unknown>} */ (withoutSecrets(kept, at, omitted));
}

/**
 * The salvage file (see the top of this file)
 * @param {SalvageRead} read
 * @param {{now: number}} options
 */
export function buildSalvage(read, { now }) {
  /** @type {Omission[]} */
  const omissions = [];
  /** @type {Unreadable[]} */
  const unreadable = [];
  if (read.database.status === 'failed') unreadable.push(whole('CanvasTabDB', readCode(read.database.errorCode, 'open-failed')));
  if (read.database.status === 'missing') unreadable.push(whole('CanvasTabDB', 'no-database'));
  const database = readStores(read.database.stores, 'CanvasTabDB', omissions, { origin: 'CanvasTabDB', pointId: null });
  unreadable.push(...database.unreadable);
  const { shaped, stores } = fromStores(database.values);

  /** @type {Record<string, unknown>} */
  const legacyCopies = {};
  for (const { key, value } of read.legacyCopies.copies) {
    legacyCopies[key] = keptCopy(value, `legacyCopies.${key}`, omissions);
  }
  if (read.legacyCopies.status === 'failed') {
    unreadable.push(whole('legacyCopies', readCode(read.legacyCopies.errorCode, 'unreadable')));
  }

  if (read.recoveryPoints.status === 'failed') {
    unreadable.push(whole('recoveryPoints', readCode(read.recoveryPoints.errorCode, 'unreadable')));
  }
  const recoveryPoints = read.recoveryPoints.points.map(point => {
    const pointId = POINT_ID.test(point.id) ? point.id : null;
    const rows = readStores(point.stores, `recoveryPoints.${point.id}`, omissions, { origin: 'recoveryPoints', pointId });
    unreadable.push(...rows.unreadable);
    return {
      id: point.id,
      kind: point.kind,
      status: point.status,
      verified: point.verified,
      createdAt: point.createdAt,
      verifiedAt: point.verifiedAt,
      stores: rows.values,
    };
  });
  // The secret store is left out of every read, so it's listed even when nothing read it
  if (!omissions.some(omission => omission.at === 'CanvasTabDB.settings')) {
    omissions.unshift({ what: 'store', at: 'CanvasTabDB.settings', reason: 'secret' });
  }

  return withCounts({
    version: 1,
    exportedAt: now,
    salvage: true,
    canvases: shaped.canvases,
    elements: shaped.elements,
    media: shaped.media,
    folders: shaped.folders,
    orphanElements: shaped.orphanElements,
    trashedCanvases: shaped.trashedCanvases,
    unimportable: shaped.unimportable,
    stores,
    legacyCopies,
    recoveryPoints,
    unreadable,
    omissions,
  });
}

/**
 * The stores that hold what the user made: what a file must hold some of to have saved
 * anything. The search index, links, vectors, `meta`, and `migrations` are derived or
 * bookkeeping, and an empty copy or point holds nothing.
 */
export const USER_STORES = Object.freeze(['canvases', 'elements', 'media', 'folders', 'themes', 'snapshots']);

/**
 * Every id `list` holds, and how many records
 * @param {unknown} list
 * @param {Set<string>} ids
 */
const tally = (list, ids) => {
  if (!Array.isArray(list)) return 0;
  for (const record of list) if (isObject(record) && typeof record.id === 'string') ids.add(record.id);
  return list.length;
};

/** A legacy copy's key in chrome.storage.local, as 1.4.x writes it */
const LEGACY_COPY_KEY = /^(?:auto|recovery)_backup_[0-9]{10,16}$/;

/**
 * How many user rows `rows` holds, in USER_STORES only
 * @param {unknown} rows
 */
const userRows = rows => {
  if (!isObject(rows)) return 0;
  let count = 0;
  for (const store of USER_STORES) if (Array.isArray(rows[store])) count += rows[store].length;
  return count;
};

/**
 * What a file read: its `unreadable` list; how many of the user's records it holds, in
 * USER_STORES only, wherever they are (CanvasTabDB's, each legacy copy's rows, each point's
 * rows); whether it holds the rows of `subjectId`, what an irreversible run destroys; and
 * whether CanvasTabDB read whole, store by store. A file that holds no user record while any
 * source is unreadable saved nothing, whatever else read.
 *
 * It holds a subject by its rows, never its name (slice 4a; "Before any irreversible
 * remediation ships"):
 * - a legacy copy, by its key, only when the file kept at least one of its user rows and left
 *   out nothing of it as an unknown store or field (`unknown-store`, `unknown-field`
 *   omissions under its key); its secrets are left out by design;
 * - a #17 point, by its id, only when no `unreadable` entry names it and the file holds at
 *   least one of its user rows;
 * - a record, by its id, only when it's in CanvasTabDB's lists as the file holds them now,
 *   never because an old copy or point holds it.
 * No subject (null) is never held: what the run destroys must be named.
 * @param {{[key: string]: unknown}} file
 * @param {string | null} [subjectId]
 * @returns {{unreadable: Unreadable[], held: number, holdsSubject: boolean, readCanvas: boolean}}
 */
export function readOf(file, subjectId = null) {
  const unreadable = Array.isArray(file.unreadable) ? /** @type {Unreadable[]} */ (file.unreadable) : [];
  // CanvasTabDB's records now, by id, and every other id the file holds
  /** @type {Set<string>} */
  const current = new Set();
  /** @type {Set<string>} */
  const elsewhere = new Set();
  let held = 0;
  // CanvasTabDB's, as the legacy shape split them
  for (const key of ['canvases', 'trashedCanvases', 'elements', 'orphanElements', 'media', 'folders']) {
    held += tally(file[key], current);
  }
  const unimportable = isObject(file.unimportable) ? file.unimportable : {};
  for (const list of Object.values(unimportable)) held += tally(list, current);
  const stores = isObject(file.stores) ? file.stores : {};
  for (const store of ['themes', 'snapshots']) held += tally(stores[store], current);
  // A copy by its rows
  const copies = isObject(file.legacyCopies) ? file.legacyCopies : {};
  for (const copy of Object.values(copies)) {
    if (isObject(copy)) for (const store of USER_STORES) held += tally(copy[store], elsewhere);
  }
  // A point by its rows
  const points = Array.isArray(file.recoveryPoints) ? file.recoveryPoints.filter(isObject) : [];
  for (const point of points) {
    const rows = isObject(point.stores) ? point.stores : {};
    for (const store of USER_STORES) held += tally(rows[store], elsewhere);
  }
  return { unreadable, held, holdsSubject: holds(file, subjectId, { copies, points, current, unreadable }), readCanvas: !unreadable.some(item => item.origin === 'CanvasTabDB') };
}

/**
 * Whether `file` holds the rows of `subjectId` (see readOf)
 * @param {{[key: string]: unknown}} file
 * @param {string | null} subjectId
 * @param {{copies: Record<string, unknown>, points: Record<string, unknown>[], current: Set<string>, unreadable: Unreadable[]}} read
 */
function holds(file, subjectId, { copies, points, current, unreadable }) {
  if (subjectId === null || subjectId === '') return false;
  if (LEGACY_COPY_KEY.test(subjectId)) {
    if (!Object.prototype.hasOwnProperty.call(copies, subjectId)) return false;
    const at = `legacyCopies.${subjectId}`;
    const omissions = Array.isArray(file.omissions) ? file.omissions : [];
    const dropped = omissions.some(
      omission =>
        isObject(omission) &&
        (omission.reason === 'unknown-store' || omission.reason === 'unknown-field') &&
        typeof omission.at === 'string' &&
        (omission.at === at || omission.at.startsWith(`${at}.`)),
    );
    return !dropped && userRows(copies[subjectId]) > 0;
  }
  if (POINT_ID.test(subjectId)) {
    const point = points.find(candidate => candidate.id === subjectId);
    if (!point || unreadable.some(item => item.pointId === subjectId)) return false;
    return userRows(point.stores) > 0;
  }
  return current.has(subjectId);
}

/**
 * A restore point's file, for Save as file: a legacy copy, or a verified #17 point, in the
 * same shape
 * @param {RestorePointRead} read
 * @param {{now: number}} options
 */
export function buildRestorePointFile(read, { now }) {
  /** @type {Omission[]} */
  const omissions = [];
  if (read.kind === 'legacy-copy') {
    const copy = keptCopy(read.value, read.key, omissions);
    /** @param {string} key */
    const list = key => (Array.isArray(copy[key]) ? /** @type {unknown[]} */ (copy[key]) : []);
    const shaped = legacyShape({
      notes: list('canvases'),
      blocks: list('elements'),
      media: list('media'),
      folders: list('folders'),
    });
    /** @type {Record<string, unknown[]>} */
    const stores = {};
    /** @type {Record<string, unknown>} */
    const extra = {};
    for (const [field, item] of Object.entries(copy)) {
      if (LEGACY_KEYS.includes(field) || field === 'version') continue;
      if (OTHER_STORES.includes(field) && Array.isArray(item)) stores[field] = item;
      else extra[field] = item;
    }
    return withCounts({
      version: 1,
      exportedAt: now,
      ...shaped,
      stores,
      restorePoint: { kind: 'legacy-copy', key: read.key, copied: extra },
      unreadable: [],
      omissions,
    });
  }
  const { point } = read;
  const rows = readStores(point.stores, point.id, omissions, {
    origin: 'recoveryPoints',
    pointId: POINT_ID.test(point.id) ? point.id : null,
  });
  const { shaped, stores } = fromStores(rows.values);
  return withCounts({
    version: 1,
    exportedAt: now,
    ...shaped,
    stores,
    restorePoint: {
      kind: 'recovery-point',
      id: point.id,
      pointKind: point.kind,
      createdAt: point.createdAt,
      verifiedAt: point.verifiedAt,
    },
    unreadable: rows.unreadable,
    omissions,
  });
}
