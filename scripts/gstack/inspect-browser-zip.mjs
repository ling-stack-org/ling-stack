import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

const defaults = { maxMembers: 5_000, maxMemberBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024, maxCompressionRatio: 10_000, maxDurationMs: 120_000 };
const maxNoticeBytes = 4 * 1024 * 1024;
const decode = bytes => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const fail = reason => { throw new Error(`gstack_browser_${reason}`); };
const cpuName = cpu => ({ 0x01000007: "x64", 0x0100000c: "arm64" })[cpu];

function normalizedPath(value) {
  if (!value || value.length > 4_096 || /[\\:\x00-\x1f\x7f]/u.test(value) || value.startsWith("/") ||
    value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/u.test(part) ||
      /[<>"|?*]/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) fail("member_path_invalid");
  return value;
}

function memberMetadata(entry, limits, target) {
  if (entry.generalPurposeBitFlag & 0x41) fail("member_encrypted");
  if (![0, 8].includes(entry.compressionMethod)) fail("member_compression_invalid");
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limits.maxMemberBytes ||
    !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
    entry.uncompressedSize > Math.max(entry.compressedSize, 1) * limits.maxCompressionRatio) fail("member_size_invalid");
  const mode = entry.externalFileAttributes >>> 16, type = mode & 0xf000;
  const directory = entry.fileName.endsWith("/"), path = normalizedPath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
  if (![0, 0x4000, 0x8000, 0xa000].includes(type) || mode & 0o7000 ||
    directory && ![0, 0x4000].includes(type) || !directory && type === 0x4000 ||
    !directory && entry.externalFileAttributes & 0x10) fail("member_type_invalid");
  const kind = directory ? "directory" : type === 0xa000 ? "link" : "file";
  if (kind === "directory" && entry.uncompressedSize || kind === "link" && entry.uncompressedSize > 4_096) fail("member_size_invalid");
  // Retain this exact original copyright/reference without classifying an
  // arbitrary ABOUT file as a license or complete third-party notice set.
  const copyrightReference = kind === "file" && target.platform === "win32" && target.arch === "x64" && path === "chrome-win64/ABOUT";
  const notice = kind === "file" && (/^(?:LICENSE(?:[._-].*)?|COPYING(?:[._-].*)?|NOTICE(?:[._-].*)?)$/iu.test(posix.basename(path)) || copyrightReference);
  if (notice && entry.uncompressedSize > maxNoticeBytes) fail("member_notice_too_large");
  return { path, kind, mode, sizeBytes: entry.uncompressedSize, compressedSizeBytes: entry.compressedSize,
    compressionMethod: entry.compressionMethod, notice, copyrightReference };
}

function thinMach(header) {
  if (header.length < 32) fail("native_header_invalid");
  const magic = header.readUInt32BE(0), little = magic === 0xcffaedfe;
  if (![0xfeedfacf, 0xcffaedfe].includes(magic)) fail("native_header_invalid");
  const word = offset => little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
  const arch = cpuName(word(4)), fileType = { 2: "executable", 6: "library", 8: "bundle" }[word(12)];
  if (!arch || !fileType) fail("native_header_invalid");
  return { arch, fileType };
}

function family(header) {
  if (header.length < 4) return undefined;
  const magic = header.readUInt32BE(0);
  if ([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe].includes(magic)) return "mach-o";
  if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) return "fat-mach-o";
  if (header.subarray(0, 2).toString("ascii") === "MZ") return "pe";
  if (magic === 0x7f454c46) return "elf";
  return undefined;
}

// Keep only bounded headers while hashing large compressed members. Universal
// slices are checked against their actual inner headers, not CPU declarations.
class NativeProbe {
  prefix = Buffer.alloc(0);
  slices;
  constructor(sizeBytes, target) { this.sizeBytes = sizeBytes; this.target = target; }
  observe(bytes, start) {
    if (this.prefix.length < 65_536) this.prefix = Buffer.concat([this.prefix, bytes.subarray(0, 65_536 - this.prefix.length)]);
    if (!this.slices && family(this.prefix) === "fat-mach-o" && this.prefix.length >= 8) {
      const magic = this.prefix.readUInt32BE(0);
      if (![0xcafebabe, 0xcafebabf].includes(magic)) fail("native_header_invalid");
      const count = this.prefix.readUInt32BE(4), entrySize = magic === 0xcafebabe ? 20 : 32;
      if (!count || count > 64) fail("native_header_invalid");
      const tableSize = 8 + count * entrySize;
      if (this.prefix.length >= tableSize) {
        this.slices = [];
        for (let index = 0; index < count; index++) {
          const position = 8 + index * entrySize, arch = cpuName(this.prefix.readUInt32BE(position));
          const offset = entrySize === 20 ? this.prefix.readUInt32BE(position + 8) : Number(this.prefix.readBigUInt64BE(position + 8));
          const size = entrySize === 20 ? this.prefix.readUInt32BE(position + 12) : Number(this.prefix.readBigUInt64BE(position + 16));
          const align = this.prefix.readUInt32BE(position + (entrySize === 20 ? 16 : 24));
          if (!arch || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < tableSize || size < 32 ||
            offset > this.sizeBytes - size || align > 30 || offset % 2 ** align ||
            this.slices.some(slice => offset < slice.offset + slice.size && slice.offset < offset + size)) fail("native_header_invalid");
          this.slices.push({ arch, offset, size, header: Buffer.alloc(32), observed: new Uint8Array(32) });
        }
        this.capture(this.prefix, 0);
      }
    }
    this.capture(bytes, start);
  }
  capture(bytes, start) {
    for (const slice of this.slices ?? []) {
      const from = Math.max(start, slice.offset), to = Math.min(start + bytes.length, slice.offset + 32);
      if (from >= to) continue;
      bytes.copy(slice.header, from - slice.offset, from - start, to - start);
      slice.observed.fill(1, from - slice.offset, to - slice.offset);
    }
  }
  result() {
    const format = family(this.prefix);
    if (!format) return undefined;
    if (format === "mach-o") {
      const result = thinMach(this.prefix);
      if (this.target.platform !== "darwin" || result.arch !== this.target.arch) fail("native_target_mismatch");
      return { format, architectures: [result.arch], fileType: result.fileType };
    }
    if (format === "fat-mach-o") {
      if (this.target.platform !== "darwin" || !this.slices?.some(slice => slice.arch === this.target.arch)) fail("native_target_mismatch");
      const types = new Set();
      for (const slice of this.slices) {
        if (slice.observed.some(value => !value)) fail("native_header_invalid");
        const result = thinMach(slice.header);
        if (result.arch !== slice.arch) fail("native_slice_mismatch");
        types.add(result.fileType);
      }
      if (types.size !== 1) fail("native_slice_mismatch");
      return { format, architectures: [...new Set(this.slices.map(slice => slice.arch))].sort(), fileType: [...types][0] };
    }
    if (format !== "pe" || this.target.platform !== "win32" || this.prefix.length < 64) fail("native_target_mismatch");
    const offset = this.prefix.readUInt32LE(0x3c);
    if (offset < 64 || offset + 26 > this.prefix.length || this.prefix.readUInt32LE(offset) !== 0x00004550) fail("native_header_invalid");
    const arch = ({ 0x8664: "x64", 0xaa64: "arm64" })[this.prefix.readUInt16LE(offset + 4)];
    if (!arch || arch !== this.target.arch) fail("native_target_mismatch");
    const optionalSize = this.prefix.readUInt16LE(offset + 20), flags = this.prefix.readUInt16LE(offset + 22);
    if (!(flags & 2) || optionalSize < 2 || offset + 24 + optionalSize > this.prefix.length ||
      this.prefix.readUInt16LE(offset + 24) !== 0x20b) fail("native_header_invalid");
    return { format, architectures: [arch], fileType: flags & 0x2000 ? "library" : "executable" };
  }
}

export function validateBrowserMemberGraph(members) {
  const nodes = new Map(), folded = new Map();
  const add = (path, member, implicit = false) => {
    const key = path.normalize("NFC").toLowerCase(), oldPath = folded.get(key), old = nodes.get(path);
    if (oldPath && oldPath !== path || old && !(implicit && old.kind === "directory")) fail("member_path_collision");
    folded.set(key, path);
    if (!old) nodes.set(path, member);
  };
  for (const member of members) add(normalizedPath(member.path), member);
  for (const member of members) {
    const parts = member.path.split("/");
    for (let count = 1; count < parts.length; count++) add(parts.slice(0, count).join("/"), { kind: "directory" }, true);
  }
  const links = members.filter(member => member.kind === "link");
  for (const link of links) {
    let path = link.path;
    const visited = new Set();
    for (let step = 0; ; step++) {
      if (step > links.length || visited.has(path)) fail("member_link_cycle");
      visited.add(path);
      const parts = path.split("/"); let redirected = false;
      for (let index = 1; index <= parts.length; index++) {
        const prefix = parts.slice(0, index).join("/"), candidate = nodes.get(prefix);
        if (candidate?.kind !== "link") continue;
        const value = candidate.linkTarget;
        if (!value || /[\\:\x00-\x1f\x7f]/u.test(value) || posix.isAbsolute(value)) fail("member_link_escape");
        path = posix.normalize(posix.join(posix.dirname(prefix), value, ...parts.slice(index)));
        if (path === ".." || path.startsWith("../") || posix.isAbsolute(path)) fail("member_link_escape");
        redirected = true; break;
      }
      if (!redirected) {
        const node = nodes.get(path);
        if (!node) fail("member_link_dangling");
        link.resolvedTarget = path; link.targetKind = node.kind; break;
      }
    }
  }
  return members;
}

export async function inspectBrowserZip({ zipPath, yauzl, target, limits: overrides = {}, rootPrefix }) {
  if (!target || !["darwin", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch)) fail("inspection_target_invalid");
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) fail("inspection_limits_invalid");
  }
  const limits = { ...defaults, ...overrides }, stat = await lstat(zipPath);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 512 * 1024 * 1024) fail("archive_file_invalid");
  const file = await open(zipPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let zip, activeStream, timer, operation;
  const members = [], notices = [];
  let totalBytes = 0;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail("archive_file_changed");
    class OwnedArchiveReader extends yauzl.RandomAccessReader {
      _readStreamForRange(start, end) {
        let position = start;
        return new Readable({ read(size) {
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > opened.size) {
            this.destroy(new Error("gstack_browser_archive_range_invalid")); return;
          }
          if (position === end) { this.push(null); return; }
          const bytes = Buffer.alloc(Math.min(size, 65_536, end - position));
          file.read(bytes, 0, bytes.length, position).then(({ bytesRead }) => {
            if (this.destroyed) return;
            if (!bytesRead) { this.destroy(new Error("gstack_browser_archive_truncated")); return; }
            position += bytesRead; this.push(bytes.subarray(0, bytesRead));
          }, error => this.destroy(error));
        } });
      }
      close(callback) { callback(); }
    }
    zip = await yauzl.fromRandomAccessReaderPromise(new OwnedArchiveReader(), opened.size,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
    if (!zip.entryCount || zip.entryCount > limits.maxMembers) fail("member_count_invalid");
    await new Promise((resolve, reject) => {
      let settled = false;
      const stop = error => {
        if (settled) return; settled = true;
        if (error) { activeStream?.destroy(error); zip.close(); reject(error); } else resolve();
      };
      timer = setTimeout(() => stop(new Error("gstack_browser_inspection_timeout")), limits.maxDurationMs);
      zip.on("error", stop); zip.on("end", () => stop());
      zip.on("entry", entry => {
        operation = (async () => {
          const member = memberMetadata(entry, limits, target);
          if (rootPrefix && member.path !== rootPrefix && !member.path.startsWith(`${rootPrefix}/`)) fail("member_root_invalid");
          if (members.length >= limits.maxMembers || totalBytes + member.sizeBytes > limits.maxTotalBytes) fail("member_total_size_invalid");
          const chunks = [], hash = createHash("sha256"), probe = new NativeProbe(member.sizeBytes, target);
          const stream = await zip.openReadStreamPromise(entry); activeStream = stream;
          let sizeBytes = 0, crc = 0;
          for await (const bytes of stream) {
            if (sizeBytes + bytes.length > member.sizeBytes) fail("member_size_mismatch");
            if (member.kind === "file") probe.observe(bytes, sizeBytes);
            sizeBytes += bytes.length; hash.update(bytes); crc = crc32(bytes, crc);
            if (member.notice || member.kind === "link") chunks.push(bytes);
          }
          activeStream = undefined;
          if (sizeBytes !== member.sizeBytes) fail("member_size_mismatch");
          if (crc !== entry.crc32) fail("member_crc_mismatch");
          member.checksum = `sha256:${hash.digest("hex")}`; member.crc32 = crc.toString(16).padStart(8, "0");
          if (member.kind === "file") {
            const native = probe.result();
            if (native) member.native = native;
            else if (/\.(?:exe|dll|dylib|so)$/iu.test(member.path)) fail("native_header_invalid");
          }
          if (member.kind === "link") member.linkTarget = decode(Buffer.concat(chunks));
          if (member.notice) {
            const text = decode(Buffer.concat(chunks));
            if (!text.trim() || text.includes("\0")) fail("member_notice_invalid");
            notices.push({ path: member.path, sizeBytes, checksum: member.checksum, text,
              ...(member.copyrightReference ? { materialKind: "copyright-reference" } : {}) });
          }
          delete member.notice;
          delete member.copyrightReference;
          totalBytes += sizeBytes; members.push(member);
          if (!settled) zip.readEntry();
        })().catch(stop);
      });
      zip.readEntry();
    });
    if (members.length !== zip.entryCount) fail("member_count_invalid");
    validateBrowserMemberGraph(members);
    const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    return { members: members.sort(compare), notices: notices.sort(compare), totalBytes };
  } finally { clearTimeout(timer); activeStream?.destroy(); zip?.close(); await operation; await file.close(); }
}
