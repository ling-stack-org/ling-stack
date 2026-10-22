import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync,
  realpathSync, writeSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

const identity = (info: BigIntStats) => ({ dev: String(info.dev), ino: String(info.ino), size: String(info.size),
  mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) });
let mutated = false;
let fd: number | undefined;
let result: unknown;
try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  const { path, content, expected, parent } = request;
  if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)
    || typeof content !== "string" || content.includes("\0")) throw new Error("invalid");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > 4 * 1024 * 1024 || bytes.toString("utf8") !== content) throw new Error("invalid");
  const directory = dirname(path), name = basename(path), info = lstatSync(".", { bigint: true });
  if (name === "." || name === ".." || realpathSync(".") !== directory || !info.isDirectory()
    || String(info.dev) !== parent.dev || String(info.ino) !== parent.ino) throw new Error("changed_parent");
  if (expected === null) {
    fd = openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
    mutated = true;
  } else {
    fd = openSync(name, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = fstatSync(fd, { bigint: true });
    if (!current.isFile() || current.nlink !== 1n || JSON.stringify(identity(current)) !== JSON.stringify(expected)
      || realpathSync(name) !== path || JSON.stringify(identity(lstatSync(name, { bigint: true }))) !== JSON.stringify(expected)) throw new Error("changed_target");
  }
  for (let offset = 0; offset < bytes.length;) {
    mutated = true;
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!written) throw new Error("short_write");
    offset += written;
  }
  mutated = true;
  ftruncateSync(fd, bytes.length);
  fsyncSync(fd);
  const actual = fstatSync(fd, { bigint: true });
  if (!actual.isFile() || actual.nlink !== 1n || actual.size !== BigInt(bytes.length)
    || realpathSync(name) !== path || JSON.stringify(identity(actual)) !== JSON.stringify(identity(lstatSync(name, { bigint: true })))) throw new Error("changed_result");
  result = { outcome: "succeeded", identity: identity(actual) };
} catch { result = { outcome: mutated ? "unknown" : "not_started" }; }
finally { if (fd !== undefined) closeSync(fd); }
process.stdout.write(JSON.stringify(result));
