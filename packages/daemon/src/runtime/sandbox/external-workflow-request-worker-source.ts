/**
 * Fixed request worker. It accepts exactly one init frame and one decision frame.
 * The Host never supplies source code, module names, commands, or filesystem APIs.
 */
export const EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
let state = "init";
let lineBuffer = "";
let admission;

function fail(code, detail) {
  try { process.stdout.write(JSON.stringify({ type: "error", code, detail: String(detail || code).slice(0, 512) }) + "\n"); }
  finally { process.exitCode = 1; process.stdin.pause(); }
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}
function statIdentity(stat) {
  return {
    dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mode: String(stat.mode),
    uid: String(stat.uid), gid: String(stat.gid), nlink: String(stat.nlink),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  };
}
function sameIdentity(first, second, includeContentState = true) {
  const current = statIdentity(second);
  const keys = includeContentState
    ? ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"]
    : ["dev", "ino"];
  return keys.every(key => first[key] === current[key]);
}
function lstatMissing(target) {
  try { return fs.lstatSync(target, { bigint: true }); }
  catch (error) { if (error && error.code === "ENOENT") return undefined; throw error; }
}
function directoryIdentity(root, target) {
  if (!inside(root, target)) throw new Error("workflow_path_outside_root");
  const stat = fs.lstatSync(target, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workflow_parent_not_directory");
  if (fs.realpathSync(target) !== target) throw new Error("workflow_path_changed");
  return { path: target, identity: statIdentity(stat) };
}
function assertDirectoriesCurrent(current) {
  for (const row of current.directories) {
    const now = directoryIdentity(current.root, row.path);
    if (!sameIdentity(row.identity, fs.lstatSync(now.path, { bigint: true }), false)) throw new Error("workflow_path_changed");
  }
}
function readExact(fd, identity) {
  const size = Number(identity.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error("workflow_file_budget_exceeded");
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, Math.min(65536, size - offset), offset);
    if (!count) throw new Error("workflow_file_changed");
    offset += count;
  }
  if (fs.readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) throw new Error("workflow_file_changed");
  return bytes;
}
function readFileSnapshot(current, target, original) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || original && !sameIdentity(original, stat)) throw new Error("workflow_file_changed");
    assertDirectoriesCurrent(current);
    const pathStat = fs.lstatSync(target, { bigint: true });
    if (!sameIdentity(statIdentity(stat), pathStat, false) || fs.realpathSync(target) !== target) throw new Error("workflow_file_changed");
    const identity = statIdentity(stat);
    const bytes = readExact(fd, identity);
    if (!sameIdentity(identity, fs.fstatSync(fd, { bigint: true }))) throw new Error("workflow_file_changed");
    assertDirectoriesCurrent(current);
    return { bytes, identity };
  } finally { fs.closeSync(fd); }
}
function snapshotDigest(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify({
    path: snapshot.path, exists: snapshot.exists, identity: snapshot.identity || null,
    bytesSha256: crypto.createHash("sha256").update(snapshot.bytes || Buffer.alloc(0)).digest("hex"),
  })).digest("hex");
}
function prepare(frame) {
  if (!exactKeys(frame, ["type", "protocolVersion", "root", "workflowPath"]) || frame.type !== "init"
    || frame.protocolVersion !== 1 || typeof frame.root !== "string"
    || !(frame.workflowPath === null || typeof frame.workflowPath === "string")) throw new Error("workflow_request_invalid");
  const root = fs.realpathSync(frame.root);
  if (root !== frame.root || !path.isAbsolute(root)) throw new Error("workflow_root_invalid");
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("workflow_root_invalid");
  const requested = path.resolve(root, frame.workflowPath || "WORKFLOW.md");
  if (!inside(root, requested) || requested === root) throw new Error("workflow_path_outside_root");
  const components = path.relative(root, requested).split(path.sep);
  const leaf = components.pop();
  const directories = [directoryIdentity(root, root)];
  let parent = root;
  let missingAt = components.length;
  for (let index = 0; index < components.length; index += 1) {
    const candidate = path.join(parent, components[index]);
    const existing = lstatMissing(candidate);
    if (!existing) { missingAt = index; break; }
    const canonical = fs.realpathSync(candidate);
    if (!inside(root, canonical)) throw new Error("workflow_path_outside_root");
    directories.push(directoryIdentity(root, canonical));
    parent = canonical;
  }
  const remaining = components.slice(missingAt);
  const target = path.join(parent, ...remaining, leaf);
  const current = { root, requested, parent, remaining, leaf, directories, path: target };
  assertDirectoriesCurrent(current);
  if (remaining.length > 0) return { current, snapshot: { path: target, exists: false } };
  const existing = lstatMissing(target);
  if (!existing) return { current, snapshot: { path: target, exists: false } };
  const canonical = fs.realpathSync(target);
  if (!inside(root, canonical)) throw new Error("workflow_path_outside_root");
  const stat = fs.lstatSync(canonical, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("workflow_path_not_file");
  current.path = canonical;
  const read = readFileSnapshot(current, canonical, statIdentity(stat));
  return { current, snapshot: { path: canonical, exists: true, bytes: read.bytes, identity: read.identity } };
}
function ensureParents(current) {
  if (current.remaining.length === 0) {
    assertDirectoriesCurrent(current);
    return;
  }
  let parent = current.parent;
  for (const component of current.remaining) {
    assertDirectoriesCurrent(current);
    const next = path.join(parent, component);
    fs.mkdirSync(next, { mode: 0o700 });
    const row = directoryIdentity(current.root, next);
    current.directories.push(row);
    parent = next;
  }
  current.path = path.join(parent, current.leaf);
  current.remaining = [];
  assertDirectoriesCurrent(current);
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
    if (!count) throw new Error("workflow_write_no_progress");
    offset += count;
  }
}
function replace(current, snapshot, bytes) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("workflow_file_budget_exceeded");
  ensureParents(current);
  const flags = fs.constants.O_RDWR | O_NOFOLLOW | (snapshot.exists ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(current.path, flags, 0o600);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("workflow_file_changed");
    if (snapshot.exists) {
      if (!sameIdentity(snapshot.identity, before) || before.nlink !== 1n) throw new Error("workflow_file_changed");
      assertDirectoriesCurrent(current);
      const oldBytes = readExact(fd, snapshot.identity);
      if (!oldBytes.equals(snapshot.bytes)) throw new Error("workflow_file_changed");
    } else if (before.nlink !== 1n) throw new Error("workflow_file_changed");
    assertDirectoriesCurrent(current);
    writeAll(fd, bytes);
    fs.ftruncateSync(fd, bytes.length);
    fs.fsyncSync(fd);
    assertDirectoriesCurrent(current);
    const identity = statIdentity(fs.fstatSync(fd, { bigint: true }));
    const finalBytes = readExact(fd, identity);
    if (!finalBytes.equals(bytes)) throw new Error("workflow_file_changed");
    const pathStat = fs.lstatSync(current.path, { bigint: true });
    if (!sameIdentity(identity, pathStat, false) || fs.realpathSync(current.path) !== current.path) throw new Error("workflow_file_changed");
    return { path: current.path, exists: true, bytes: finalBytes, identity };
  } finally { fs.closeSync(fd); }
}
function respondSnapshot(snapshot) {
  const token = snapshotDigest(snapshot);
  process.stdout.write(JSON.stringify({ type: "snapshot", protocolVersion: 1, token,
    path: snapshot.path, exists: snapshot.exists,
    bytesBase64: snapshot.bytes ? snapshot.bytes.toString("base64") : undefined,
    identity: snapshot.identity }) + "\n");
  return token;
}
function handle(frame) {
  if (state === "init") {
    const prepared = prepare(frame);
    const token = respondSnapshot(prepared.snapshot);
    admission = { ...prepared, token };
    state = "decision";
    return;
  }
  if (state !== "decision" || !exactKeys(frame, frame.action === "keep"
    ? ["type", "protocolVersion", "token", "action"]
    : ["type", "protocolVersion", "token", "action", "markdownBase64"])
    || frame.type !== "decision" || frame.protocolVersion !== 1 || frame.token !== admission.token
    || !["keep", "replace"].includes(frame.action)) throw new Error("workflow_decision_invalid");
  let result;
  if (frame.action === "keep") {
    if (!admission.snapshot.exists) throw new Error("workflow_decision_invalid");
    const read = readFileSnapshot(admission.current, admission.snapshot.path, admission.snapshot.identity);
    if (!read.bytes.equals(admission.snapshot.bytes)) throw new Error("workflow_file_changed");
    result = { path: admission.snapshot.path, exists: true, bytes: read.bytes, identity: read.identity };
  } else {
    if (typeof frame.markdownBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.markdownBase64))
      throw new Error("workflow_decision_invalid");
    result = replace(admission.current, admission.snapshot, Buffer.from(frame.markdownBase64, "base64"));
  }
  process.stdout.write(JSON.stringify({ type: "result", protocolVersion: 1, path: result.path,
    exists: true, bytesBase64: result.bytes.toString("base64"), identity: result.identity }) + "\n");
  state = "done";
  process.stdin.pause();
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  if (state === "done" || process.exitCode) return;
  lineBuffer += chunk;
  if (Buffer.byteLength(lineBuffer) > MAX_FRAME_BYTES) return fail("workflow_frame_budget_exceeded");
  for (;;) {
    const newline = lineBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (error) { return fail(error && error.message || "workflow_worker_failed"); }
  }
});
process.stdin.on("end", () => { if (state !== "done" && !process.exitCode) fail("workflow_request_incomplete"); });
process.stdin.resume();
`;
