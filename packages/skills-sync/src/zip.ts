// A ZIP writer for the upload archives, with no dependency: every entry stored (no compression), one fixed timestamp,
// entries in path order. The same files give the same bytes on every machine, so an archive's hash says whether it
// changed. Layout per the ZIP specification (APPNOTE.TXT): local file headers with their data, the central directory,
// the end record. No ZIP64, no directory entries (a path implies its folders), no symlinks (the caller never passes one).
import { cmp } from "./sources.js";

/** 1980-01-01 00:00:00, the earliest moment the DOS format holds: date = (year - 1980) << 9 | month << 5 | day. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Version 2.0 to extract, the baseline every reader has. */
const VERSION = 20;
/** General purpose bit 11: the name is UTF-8. */
const UTF8 = 0x0800;
const STORED = 0;
/** What the format holds without ZIP64. */
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

/** The CRC-32 table (polynomial 0xEDB88320, reflected), computed once. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The archive of `files` (path -> bytes): paths with forward slashes, sorted by code point, so the bytes depend on
 * the files alone, never on the order they were read in or the machine they were read on.
 */
export function zip(files: Map<string, Buffer>): Buffer {
  const entries = [...files].map(([name, data]) => ({ name: Buffer.from(name.split("\\").join("/"), "utf8"), data })).sort((a, b) => cmp(a.name.toString("utf8"), b.name.toString("utf8")));
  if (entries.length > MAX_ENTRIES) throw new Error(`${entries.length} files are more than a ZIP holds without ZIP64`);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    // what both headers say about the entry: version, flags, method, time, date, crc, sizes, name and extra lengths
    const common = Buffer.alloc(26);
    common.writeUInt16LE(VERSION, 0);
    common.writeUInt16LE(UTF8, 2);
    common.writeUInt16LE(STORED, 4);
    common.writeUInt16LE(DOS_TIME, 6);
    common.writeUInt16LE(DOS_DATE, 8);
    common.writeUInt32LE(crc32(data), 10);
    common.writeUInt32LE(data.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(name.length, 22);
    common.writeUInt16LE(0, 24);
    const local = Buffer.concat([u32(0x04034b50), common, name, data]);
    // central header: signature, version made by (2.0, DOS), the common part, then comment length, disk, internal
    // and external attributes (all zero) and where the local header starts
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    central.push(Buffer.concat([u32(0x02014b50), u16(VERSION), common, tail, name]));
    locals.push(local);
    offset += local.length;
    if (offset > MAX_SIZE) throw new Error("the archive is larger than a ZIP holds without ZIP64");
  }
  const directory = Buffer.concat(central);
  // end record: signature, this disk, the directory's disk, entries on this disk, entries in all, directory size, its offset, comment length
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
