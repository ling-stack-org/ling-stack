/**
 * T2-B disposable-fixture prototype, NOT a product filesystem boundary.
 *
 * Fresh file bytes break source hardlink aliases. Changes are proposals; the
 * prototype deliberately has no production publication or quiescence API.
 * The fixture importer exercises conflict checks and replacement (not in-place
 * writes), but does not claim atomic multi-file commit or hostile-race safety.
 */
import { createHash } from "node:crypto";
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const sessions = new WeakMap();
const proposals = new WeakMap();
const maximumFiles = 128;
const maximumFileBytes = 2 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const assert = (condition, code) => { if (!condition) fail(code); };

/** Creates only new, private, task-owned temporary fixture directories. */
export function createIsolatedCopyFixture() {
  const root = mkdtempSync("/private/tmp/ling-isolated-copy-");
  const origin = join(root, "origin");
  const execution = join(root, "execution");
  const scratch = join(root, "scratch");
  const outside = join(root, "outside");
  const staging = join(root, "host-staging");
  for (const path of [origin, execution, scratch, outside, staging]) mkdirSync(path, { mode: 0o700 });
  const fixture = Object.freeze({ root, origin, execution, scratch, outside });
  sessions.set(fixture, {
    staging, roots: [root, origin, execution, scratch, outside, staging].map(directoryFact),
    baseline: undefined,
  });
  return fixture;
}

function directoryFact(path) {
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path, "fixture_directory_changed");
  return { path, dev: stat.dev, ino: stat.ino };
}

function requireSession(fixture) {
  const session = sessions.get(fixture);
  assert(session, "unknown_fixture");
  for (const fact of session.roots) {
    const current = directoryFact(fact.path);
    assert(current.dev === fact.dev && current.ino === fact.ino, "fixture_directory_changed");
  }
  return session;
}

function regularFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert(before.isFile() && before.size <= BigInt(maximumFileBytes), "fixture_file_unsupported");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    assert(bytes.length <= maximumFileBytes && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs,
    "fixture_file_changed_during_read");
    return { bytes, hash: digest(bytes), dev: String(after.dev), ino: String(after.ino), mode: Number(after.mode & 0o777n) };
  } finally {
    closeSync(descriptor);
  }
}

function scan(root) {
  const entries = new Map();
  const walk = (path, depth) => {
    assert(depth <= 16, "fixture_tree_limit");
    directoryFact(path);
    for (const name of readdirSync(path).sort()) {
      const target = join(path, name);
      const stat = lstatSync(target);
      assert(!stat.isSymbolicLink(), "fixture_symlink_unsupported");
      if (stat.isDirectory()) walk(target, depth + 1);
      else {
        assert(stat.isFile() && entries.size < maximumFiles, "fixture_tree_limit");
        const key = relative(root, target);
        assert(key && !key.startsWith(".." + sep) && !resolve(root, key).startsWith(root + sep + ".." + sep), "fixture_path_invalid");
        entries.set(key, regularFile(target));
      }
    }
  };
  walk(root, 0);
  return entries;
}

/** Capture once, before starting any untrusted command. Never preserve inode aliases. */
export function captureIsolatedCopy(fixture) {
  const session = requireSession(fixture);
  assert(session.baseline === undefined && readdirSync(fixture.execution).length === 0, "fixture_already_captured");
  const source = scan(fixture.origin);
  for (const [path, entry] of source) {
    const target = join(fixture.execution, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, entry.bytes, { flag: "wx", mode: entry.mode & 0o777 });
    const copy = regularFile(target);
    assert(copy.hash === entry.hash && (copy.dev !== entry.dev || copy.ino !== entry.ino), "fixture_alias_not_broken");
  }
  session.baseline = source;
  return Object.freeze({ fileCount: source.size, executionRoot: fixture.execution });
}

/**
 * Freeze output bytes in Host memory for this small prototype. The output tree
 * stays untrusted; symlinks and unstable reads are rejected, never followed.
 */
export function proposeIsolatedChanges(fixture) {
  const session = requireSession(fixture);
  assert(session.baseline, "fixture_not_captured");
  const output = scan(fixture.execution);
  const changes = [];
  const bytes = new Map();
  for (const path of [...new Set([...session.baseline.keys(), ...output.keys()])].sort()) {
    const before = session.baseline.get(path);
    const after = output.get(path);
    if (before?.hash === after?.hash && before?.mode === after?.mode) continue;
    const kind = !before ? "create" : !after ? "delete" : "replace";
    changes.push(Object.freeze({ path, kind, baseHash: before?.hash, outputHash: after?.hash }));
    if (after) bytes.set(path, { ...after, bytes: Buffer.from(after.bytes) });
  }
  const proposal = Object.freeze({ changes: Object.freeze(changes) });
  proposals.set(proposal, { fixture, baseline: session.baseline, bytes, consumed: false });
  return proposal;
}

/**
 * Intentionally fixture-only. This is NOT called by Daemon/Runner or authorized
 * by a model-provided flag. Real publication remains blocked until lifecycle
 * ownership, atomic destination operations and a durable journal are designed.
 *
 * Single-file replacement demonstrates why replacing a directory entry does
 * not mutate the old hardlink's inode. A changed baseline rejects before write.
 */
export function importSingleFixtureChange(fixture, proposal) {
  const session = requireSession(fixture);
  const pending = proposals.get(proposal);
  assert(pending?.fixture === fixture && !pending.consumed, "fixture_proposal_invalid");
  assert(proposal.changes.length === 1, "fixture_single_change_only");
  const [change] = proposal.changes;
  assert(change.kind === "replace", "fixture_replace_only");
  const original = scan(fixture.origin).get(change.path);
  const baseline = pending.baseline.get(change.path);
  assert(original && baseline && original.hash === baseline.hash && original.mode === baseline.mode
    && original.dev === baseline.dev && original.ino === baseline.ino, "fixture_source_conflict");
  const output = pending.bytes.get(change.path);
  assert(output && digest(output.bytes) === change.outputHash, "fixture_output_invalid");
  // Consume even if subsequent staging fails. No automatic publication replay.
  pending.consumed = true;
  const stage = join(mkdtempSync(join(session.staging, "proposal-")), "replacement");
  const descriptor = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, output.mode);
  try { writeFileSync(descriptor, output.bytes); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  // Trusted, non-concurrent disposable fixture only. Production needs a native
  // directory-FD protocol and recovery; this pathname rename is NOT that protocol.
  renameSync(stage, join(fixture.origin, change.path));
  return Object.freeze({ status: "fixture_imported", hash: output.hash, productionReady: false });
}
