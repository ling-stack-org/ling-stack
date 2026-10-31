import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireResourceLease, RESOURCE_REVIEW_HOLD_NAME, within } from "./resource-workspace.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const MAX_BYTES = 16 * 1024;
const identity = stat => ({ device: stat.dev, inode: stat.ino, mode: stat.mode, uid: stat.uid });
const absent = async path => {
  try { await lstat(path); throw new Error("gstack_qa_selection_destination_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
};

async function directory(path) {
  const info = await lstat(path);
  if (!isAbsolute(path) || !info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path
    || info.uid !== process.getuid?.() || (info.mode & 0o022)) throw new Error("gstack_qa_selection_directory_invalid");
  return identity(info);
}

async function snapshot(path, maxLinks = 1) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1 || before.nlink > maxLinks
    || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600
    || before.size > MAX_BYTES || await realpath(path) !== path) throw new Error("gstack_qa_selection_file_invalid");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!isDeepStrictEqual(identity(opened), identity(before))) throw new Error("gstack_qa_selection_file_changed");
    // A growing file must not turn the admission-size check into an unbounded
    // read. One extra byte distinguishes an exact-budget file from overflow.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error("gstack_qa_selection_over_budget");
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat(), current = await lstat(path);
    if (!isDeepStrictEqual(identity(after), identity(before)) || !isDeepStrictEqual(identity(current), identity(before))
      || bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || current.nlink !== before.nlink) throw new Error("gstack_qa_selection_file_changed");
    return { ...identity(before), size: bytes.length, checksum: hash(bytes), bytes };
  } finally { await handle.close(); }
}

async function matches(path, expected, maxLinks = 1) {
  const current = await snapshot(path, maxLinks);
  if (!isDeepStrictEqual(current, expected)) throw new Error("gstack_qa_selection_ownership_changed");
  return current;
}

async function writeNew(path, bytes) {
  if (bytes.length > MAX_BYTES) throw new Error("gstack_qa_selection_over_budget");
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return snapshot(path);
}

/** Ownership, not bundle approval: the caller must authenticate the executable
 * before claiming it and at every build boundary. Only controlled/cooperating
 * writers are in scope; this is not a same-UID adversarial filesystem CAS. */
export async function claimQaTemporarySelection({ selectionPath, expectedPreviousChecksum, candidate, env = process.env }) {
  // Capture the same bytes and lease inputs that will be consumed, before any
  // await gives the caller an opportunity to mutate its objects.
  const leaseEnv = Object.freeze(Object.fromEntries(["LING_GSTACK_RESOURCE_ROOT", "LING_GSTACK_RESOURCE_TOKEN", "TMPDIR", "TMP", "TEMP"]
    .map(key => [key, env[key]])));
  const serialized = JSON.stringify(candidate, null, 2);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) + 1 > MAX_BYTES) throw new Error("gstack_qa_selection_inputs_invalid");
  const candidateBytes = Buffer.from(`${serialized}\n`);
  candidate = JSON.parse(serialized);
  const lease = await requireResourceLease(leaseEnv);
  if (basename(selectionPath) !== "gstack-desktop-selection.json" || !isAbsolute(selectionPath)
    || !/^sha256:[a-f0-9]{64}$/.test(expectedPreviousChecksum ?? "")
    || !candidate || typeof candidate.root !== "string" || !candidate.identity
    || !within(lease.scratchPath, candidate.root) || candidate.root === lease.scratchPath
    || await realpath(candidate.root) !== candidate.root) throw new Error("gstack_qa_selection_inputs_invalid");
  const parent = dirname(selectionPath), parentIdentity = await directory(parent);
  const previous = await snapshot(selectionPath);
  if (previous.checksum !== expectedPreviousChecksum) throw new Error("gstack_qa_selection_predecessor_changed");
  const token = lease.token;
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("gstack_qa_selection_token_invalid");
  const custodyDirectory = join(parent, `.gstack-qa-selection-${token}`);
  await mkdir(custodyDirectory, { mode: 0o700 });
  const custodyIdentity = await directory(custodyDirectory);
  const backupPath = join(custodyDirectory, "previous.json"), stagedPath = join(custodyDirectory, "candidate.json");
  const installedPath = join(custodyDirectory, "installed.json");
  const staged = await writeNew(stagedPath, candidateBytes);
  const holdPath = join(lease.scratchPath, RESOURCE_REVIEW_HOLD_NAME);
  const hold = await writeNew(holdPath, Buffer.from(`${JSON.stringify({ schemaVersion: 1,
    scope: "gstack-qa-temporary-selection", token, selectionPath, custodyDirectory,
    previousChecksum: previous.checksum, candidateChecksum: staged.checksum, candidateRoot: candidate.root })}\n`));
  // A durable hold is established before the old pointer can move. Any failed
  // claim after here leaves that hold and custody files for explicit recovery.
  const checkDirectories = async () => {
    if (!isDeepStrictEqual(await directory(parent), parentIdentity)
      || !isDeepStrictEqual(await directory(custodyDirectory), custodyIdentity)) throw new Error("gstack_qa_selection_directory_changed");
  };
  await checkDirectories(); await matches(holdPath, hold); await matches(selectionPath, previous);
  await absent(backupPath);
  await rename(selectionPath, backupPath);
  await matches(backupPath, previous);
  await link(stagedPath, selectionPath); // Never overwrite an intervening writer.
  await matches(stagedPath, staged, 2);
  await matches(selectionPath, staged, 2);
  await unlink(stagedPath);
  await matches(selectionPath, staged);
  let restored = false, restoreWork;
  const checkpoint = async () => {
    if (restored) throw new Error("gstack_qa_selection_already_restored");
    await requireResourceLease(leaseEnv);
    await checkDirectories();
    await matches(holdPath, hold);
    await matches(backupPath, previous);
    await matches(selectionPath, staged);
  };
  return { selectionPath, custodyDirectory, holdPath, previousChecksum: previous.checksum, candidateChecksum: staged.checksum,
    checkpoint,
    restore() {
      // Reentrant cleanup must never run two rename/link sequences. Keep a
      // rejected attempt too: partial restoration needs explicit review.
      return restoreWork ??= (async () => {
      await checkpoint();
      await absent(installedPath);
      await rename(selectionPath, installedPath);
      await matches(installedPath, staged);
      await link(backupPath, selectionPath); // Exclusive restoration, not rename-overwrite.
      await matches(selectionPath, previous, 2);
      await matches(backupPath, previous, 2);
      await unlink(backupPath);
      await matches(selectionPath, previous);
      await checkDirectories();
      await matches(holdPath, hold);
      await writeNew(join(custodyDirectory, "restoration.json"), Buffer.from(`${JSON.stringify({
        scope: "gstack-qa-selection-restoration", token, selectionPath,
        checksum: previous.checksum, inode: previous.inode, releaseAuthorized: true })}\n`));
      await unlink(holdPath);
      restored = true;
      })();
    },
  };
}

export async function withQaTemporarySelection(options, consume) {
  const selection = await claimQaTemporarySelection(options);
  let value, failed = false, failure;
  try { value = await consume(selection); }
  catch (error) { failed = true; failure = error; }
  try { await selection.restore(); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], "gstack_qa_selection_consumption_and_restore_failed");
    throw error;
  }
  if (failed) throw failure;
  return value;
}
