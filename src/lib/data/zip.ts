import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP reader, enough for the Binance archives and nothing more.
 *
 * Written by hand instead of pulling a dependency: the whole job is "find the
 * central directory, inflate the entries", node ships the inflate, and the
 * archives are single-entry deflate files produced by a standard zipper. Adding
 * a package for eighty lines of buffer arithmetic would be worse than owning it,
 * and reading the central directory (rather than the local header) means the
 * streaming-descriptor flag, which leaves zeroed sizes in the local header,
 * cannot trip us up.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  data: Buffer;
  compressedSize: number;
  uncompressedSize: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError("end of central directory not found (truncated or not a zip)");
}

export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError(`buffer too small to be a zip (${buf.length} bytes)`);
  const eocd = findEocd(buf);

  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) {
    throw new ZipError("zip64 archives are not supported");
  }

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new ZipError("zip64 archives are not supported");

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new ZipError(`central directory entry ${i} is malformed`);
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    if (flags & 0x1) throw new ZipError(`entry "${name}" is encrypted`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipError(`entry "${name}" needs zip64`);
    }

    if (!name.endsWith("/")) {
      entries.push({
        name,
        compressedSize,
        uncompressedSize,
        data: inflateEntry(buf, localOffset, method, compressedSize, uncompressedSize, name),
      });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(
  buf: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  name: string,
): Buffer {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new ZipError(`entry "${name}" has a broken local header`);
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const end = start + compressedSize;
  if (end > buf.length) throw new ZipError(`entry "${name}" runs past the end of the buffer`);

  const raw = buf.subarray(start, end);
  let data: Buffer;
  if (method === METHOD_STORED) data = Buffer.from(raw);
  else if (method === METHOD_DEFLATE) data = inflateRawSync(raw);
  else throw new ZipError(`entry "${name}" uses unsupported compression method ${method}`);

  if (data.length !== uncompressedSize) {
    throw new ZipError(
      `entry "${name}" decompressed to ${data.length} bytes, central directory says ${uncompressedSize}`,
    );
  }
  return data;
}

/** The Binance archives hold exactly one CSV; anything else means the format changed. */
export function readSingleZipEntry(buf: Buffer): ZipEntry {
  const entries = readZip(buf);
  if (entries.length === 0) throw new ZipError("archive has no files");
  if (entries.length > 1) {
    throw new ZipError(`archive has ${entries.length} files, expected exactly one: ${entries.map((e) => e.name).join(", ")}`);
  }
  return entries[0];
}
