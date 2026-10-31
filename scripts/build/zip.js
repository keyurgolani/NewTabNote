'use strict';

/**
 * The package zip (#27 AC4), written so the same files always make the same bytes: entries
 * sorted by path, every date SOURCE_DATE_EPOCH in UTC, every mode 0644, every entry deflated
 * at level 9 by Node's zlib, and no extra fields, data descriptors, directory entries, or
 * comments. readZip reads such a zip back for the checks, and refuses what writeZip never
 * writes.
 */

const zlib = require('node:zlib');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** 2.0, the version deflate needs */
const VERSION = 20;
/** Unix, so the external attributes carry a file mode */
const MADE_BY = (3 << 8) | VERSION;
/** General purpose bit 11: the name is UTF-8 */
const UTF8_NAMES = 0x0800;
const DEFLATED = 8;
const STORED = 0;
/** A regular file, rw-r--r-- */
const FILE_MODE = 0o100644;
/** 1980-01-01T00:00:00Z, the earliest date a zip entry can hold */
const ZIP_EPOCH = 315532800;
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/**
 * @typedef {object} ZipFile
 * @property {string} path - with / between folders
 * @property {Buffer} data
 */

/**
 * The DOS date and time of `seconds` after the Unix epoch, in UTC. DOS time counts seconds in
 * twos, and nothing before 1980 or after 2107 fits.
 * @param {number} seconds
 * @returns {{date: number, time: number}}
 */
function dosDateTime(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error(`SOURCE_DATE_EPOCH ${seconds} isn't a whole number of seconds`);
  const at = new Date(Math.max(seconds, ZIP_EPOCH) * 1000);
  const year = at.getUTCFullYear();
  if (year > 2107) throw new Error(`SOURCE_DATE_EPOCH ${seconds} is after 2107, which a zip can't hold`);
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { date, time };
}

/**
 * Byte order of the UTF-8 paths, the same on every machine
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byPath(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * A zip of `files`
 * @param {ZipFile[]} files
 * @param {{sourceDateEpoch: number}} options
 * @returns {Buffer}
 */
function writeZip(files, { sourceDateEpoch }) {
  const sorted = [...files].sort((a, b) => byPath(a.path, b.path));
  if (sorted.length > MAX_ENTRIES) throw new Error(`${sorted.length} files is more than a zip without Zip64 holds`);
  const { date, time } = dosDateTime(sourceDateEpoch);
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;

  for (let i = 0; i < sorted.length; i++) {
    const { path: name, data } = sorted[i];
    if (!name || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) {
      throw new Error(`${JSON.stringify(name)} isn't a relative path inside the package`);
    }
    if (i > 0 && sorted[i - 1].path === name) throw new Error(`${name} is in the zip twice`);
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    if (data.length >= MAX_UINT32 || compressed.length >= MAX_UINT32 || offset >= MAX_UINT32) {
      throw new Error(`${name} is too large for a zip without Zip64`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(MADE_BY, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra field, comment, disk number start, internal attributes: all zero
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * @typedef {object} ZipEntry
 * @property {string} path
 * @property {Buffer} data
 * @property {number} mode - the Unix mode from the external attributes
 * @property {number} date - DOS date
 * @property {number} time - DOS time
 */

/**
 * The entries of a zip, in its central directory's order. Throws on what writeZip never
 * writes: Zip64, a multi-disk archive, encryption, a method other than deflate or store, or a
 * CRC that doesn't match.
 * @param {Buffer} buffer
 * @returns {ZipEntry[]}
 */
function readZip(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip: no end of central directory record');
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new Error('a multi-disk zip');
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === MAX_ENTRIES || directoryOffset === MAX_UINT32) throw new Error('a Zip64 archive');

  /** @type {ZipEntry[]} */
  const entries = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error(`no central directory header at byte ${at}`);
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const time = buffer.readUInt16LE(at + 12);
    const date = buffer.readUInt16LE(at + 14);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const attributes = buffer.readUInt32LE(at + 38);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`${name} is encrypted`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error(`${name} has no local header at byte ${localOffset}`);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === DEFLATED) data = zlib.inflateRawSync(raw);
    else if (method === STORED) data = Buffer.from(raw);
    else throw new Error(`${name} uses compression method ${method}`);
    if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(`${name} doesn't match its size or CRC`);
    entries.push({ path: name, data, mode: attributes >>> 16, date, time });
  }
  return entries;
}

module.exports = { ZIP_EPOCH, FILE_MODE, dosDateTime, byPath, writeZip, readZip };
