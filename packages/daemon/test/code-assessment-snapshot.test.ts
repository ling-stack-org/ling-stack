import assert from "node:assert/strict";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { codeAssessmentHunkContent } from "@ling-stack/contracts";
import { captureCodeAssessmentSnapshot, isSensitiveAssessmentPath } from "../dist/features/code-assessments/snapshot.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout;
}
async function repo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ling-assessment-snapshot-"));
  await git(cwd, "init", "-q", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "Ling Test");
  await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
  await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "initial");
  return cwd;
}

test("working tree uses the net HEAD baseline, skipping staged edits subsequently reverted", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
    await git(cwd, "add", "app.ts");
    await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
    const empty = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(empty.totalFileCount, 0);
    await writeFile(join(cwd, "app.ts"), "export const value = 3;\n");
    const changed = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.match(changed.files[0]!.diff, /-export const value = 1;/u);
    assert.match(changed.files[0]!.diff, /\+export const value = 3;/u);
    assert.doesNotMatch(changed.files[0]!.diff, /value = 2/u);
    assert.notEqual(changed.digest, empty.digest);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("sensitive, binary, oversized and symlink files are explicit coverage exclusions", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, ".env"), "TOKEN=secret\n");
    await writeFile(join(cwd, "image.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(cwd, "big.txt"), "x".repeat(100 * 1024));
    await symlink("/etc/passwd", join(cwd, "link.txt"));
    await writeFile(join(cwd, "new.ts"), "export const added = true;\n");
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(snapshot.coverage, "partial");
    assert.deepEqual(snapshot.files.map(file => file.path), ["new.ts"]);
    assert.deepEqual(new Map(snapshot.exclusions.map(item => [item.path, item.reason])), new Map([
      [".env", "sensitive"], ["image.bin", "binary"], ["big.txt", "truncated"], ["link.txt", "unsupported"],
    ]));
    assert.doesNotMatch(JSON.stringify(snapshot), /TOKEN=secret/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("untracked hard links are excluded before their contents enter the snapshot", async () => {
  const cwd = await repo();
  const outside = await mkdtemp(join(tmpdir(), "ling-assessment-hardlink-"));
  try {
    await writeFile(join(outside, "credential.txt"), "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n");
    await link(join(outside, "credential.txt"), join(cwd, "ordinary.ts"));
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(snapshot.files.length, 0);
    assert.deepEqual(snapshot.exclusions, [{ path: "ordinary.ts", reason: "unsupported" }]);
    assert.doesNotMatch(JSON.stringify(snapshot), /AKIAIOSFODNN7EXAMPLE/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("branch uses merge-base and pinned committed content, ignoring dirty worktree edits", async () => {
  const cwd = await repo();
  try {
    await git(cwd, "switch", "-qc", "feature");
    await writeFile(join(cwd, "app.ts"), "export const value = 3;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "feature");
    await writeFile(join(cwd, "app.ts"), "export const value = 99;\n");
    await writeFile(join(cwd, "dirty.ts"), "worktree only\n");
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "branch", baseRef: "main" });
    assert.equal(snapshot.baseSha?.length, 40);
    assert.deepEqual(snapshot.files.map(file => file.path), ["app.ts"]);
    assert.match(snapshot.files[0]!.diff, /value = 3/u);
    assert.doesNotMatch(snapshot.files[0]!.diff, /value = 99/u);
    assert.equal(snapshot.coverage, "complete");
    await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "branch", baseRef: "missing" }));
    await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "branch", baseRef: "--output=bad" }), /baseRef/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("rename and deleted hunks preserve old/new paths and metadata-only changes", async () => {
  const cwd = await repo();
  try {
    await git(cwd, "mv", "app.ts", "renamed.ts");
    const renamed = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(renamed.files[0]?.originalPath, "app.ts");
    assert.equal(renamed.files[0]?.kind, "renamed");
    await git(cwd, "commit", "-qm", "rename");
    await rm(join(cwd, "renamed.ts"));
    const deleted = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(deleted.files[0]?.kind, "deleted");
    assert.match(deleted.files[0]!.diff, /-export const value = 1;/u);
    assert.equal(isSensitiveAssessmentPath("src/.env.production"), true);
    assert.equal(isSensitiveAssessmentPath("cert.key"), true);
    assert.equal(isSensitiveAssessmentPath("src/app.ts"), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("capture does not run repository-configured clean filters", async () => {
  const cwd = await repo();
  try {
    await git(cwd, "config", "filter.assessment.clean", "touch filter-ran; cat");
    await git(cwd, "config", "filter.assessment.required", "true");
    await writeFile(join(cwd, ".gitattributes"), "*.ts filter=assessment\n");
    await writeFile(join(cwd, "app.ts"), "export const value = 4;\n");
    const captured = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(captured.files.some(file => file.path === "app.ts"), true);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(cwd, "filter-ran")), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("redacted snapshots retain raw-change identity without exposing secret values", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, "config.ts"), 'export const password = "private-value-one";\n');
    const first = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    await writeFile(join(cwd, "config.ts"), 'export const password = "private-value-two";\n');
    const second = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(first.coverage, "partial");
    assert.equal(first.files[0]?.redacted, true);
    assert.equal(first.files[0]?.diff, second.files[0]?.diff);
    assert.notEqual(first.files[0]?.contentDigest, second.files[0]?.contentDigest);
    assert.notEqual(first.digest, second.digest);
    assert.doesNotMatch(JSON.stringify([first, second]), /private-value-(?:one|two)/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("redacted snapshots cover unquoted and non-pattern credential values", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, "config.ts"), [
      "export const password = private-value-one;",
      "export const access_token: opaque-token-one,",
      "export const credentials = custom-credential-one;",
    ].join("\n") + "\n");
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    const serialized = JSON.stringify(snapshot);
    assert.equal(snapshot.coverage, "partial");
    assert.equal(snapshot.files[0]?.redacted, true);
    assert.doesNotMatch(serialized, /private-value-one|opaque-token-one|custom-credential-one/u);
    assert.match(snapshot.files[0]?.diff ?? "", /password = \[REDACTED\]/u);
    assert.match(snapshot.files[0]?.diff ?? "", /access_token: \[REDACTED\]/u);
    assert.match(snapshot.files[0]?.diff ?? "", /credentials = \[REDACTED\]/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("redacted snapshots cover conventional credentials in ordinary source files", async () => {
  const cwd = await repo();
  try {
    const databaseUrl = `postgres://alice:${["db", "password"].join("-")}@example.test/app`;
    await writeFile(join(cwd, "config.ts"), [
      'export const AWS_SECRET_ACCESS_KEY = "secret-access-value";',
      "export const AWS_SESSION_TOKEN = secret-session-value;",
      `export const DATABASE_URL = "${databaseUrl}";`,
      'export const password = "prefix\\\"SECRET-SUFFIX"; console.log("safe");',
    ].join("\n") + "\n");
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    const serialized = JSON.stringify(snapshot);
    assert.equal(snapshot.coverage, "partial");
    assert.equal(snapshot.files[0]?.redacted, true);
    assert.doesNotMatch(serialized, /secret-access-value|secret-session-value|db-password|SECRET-SUFFIX/u);
    assert.match(snapshot.files[0]?.diff ?? "", /AWS_SECRET_ACCESS_KEY = "\[REDACTED\]"/u);
    assert.match(snapshot.files[0]?.diff ?? "", /AWS_SESSION_TOKEN = \[REDACTED\]/u);
    assert.match(snapshot.files[0]?.diff ?? "", /DATABASE_URL = "\[REDACTED\]"/u);
    assert.match(snapshot.files[0]?.diff ?? "", /password = "\[REDACTED\]"; console\.log\("safe"\)/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("multiline redaction excludes a file if its Diff line anchors would shift", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, "config.ts"), [
      "export const password = `fixture-first-line",
      "fixture-second-line`;",
      "export const nextSetting = true;",
    ].join("\n") + "\n");
    await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(snapshot.coverage, "partial");
    assert.deepEqual(snapshot.exclusions, [{ path: "config.ts", reason: "sensitive" }]);
    assert.deepEqual(snapshot.files.map(file => file.path), ["app.ts"]);
    assert.equal(codeAssessmentHunkContent(snapshot.files[0]!.diff, "new").get(1), "export const value = 2;");
    assert.doesNotMatch(JSON.stringify(snapshot), /fixture-(first|second)-line/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("branch assessment excludes changes unique to a diverged base branch", async () => {
  const cwd = await repo();
  try {
    await git(cwd, "switch", "-qc", "feature");
    await writeFile(join(cwd, "feature.ts"), "export const feature = true;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "feature");
    await git(cwd, "switch", "-q", "main");
    await writeFile(join(cwd, "base-only.ts"), "export const base = true;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base change");
    await git(cwd, "switch", "-q", "feature");
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "branch", baseRef: "main" });
    assert.deepEqual(snapshot.files.map(file => file.path), ["feature.ts"]);
    assert.notEqual(snapshot.baseSha, (await git(cwd, "rev-parse", "main")).trim());
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("tracked binary and symbolic-link changes remain explicit exclusions", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1]));
    await symlink("app.ts", join(cwd, "link.ts"));
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "non-text");
    await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 2]));
    await rm(join(cwd, "link.ts"));
    await symlink("/etc/passwd", join(cwd, "link.ts"));
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(snapshot.coverage, "partial");
    assert.equal(snapshot.files.length, 0);
    assert.deepEqual(new Map(snapshot.exclusions.map(item => [item.path, item.reason])), new Map([
      ["binary.dat", "binary"], ["link.ts", "unsupported"],
    ]));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("commit capture compares its first parent and stays stable across worktree and HEAD changes", async () => {
  const cwd = await repo();
  try {
    const parentSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "assessed commit");
    const commitSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    await writeFile(join(cwd, "app.ts"), "export const value = 3;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "later commit");
    await writeFile(join(cwd, "app.ts"), "export const value = 99;\n");
    await git(cwd, "add", "app.ts");
    await writeFile(join(cwd, "dirty.ts"), "worktree only\n");
    const first = await captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha });
    assert.equal(first.headSha, commitSha);
    assert.equal(first.baseSha, parentSha);
    assert.equal(first.branchName, undefined);
    assert.deepEqual(first.files.map(file => file.path), ["app.ts"]);
    assert.equal(codeAssessmentHunkContent(first.files[0]!.diff, "old").get(1), "export const value = 1;");
    assert.equal(codeAssessmentHunkContent(first.files[0]!.diff, "new").get(1), "export const value = 2;");
    await git(cwd, "reset", "--hard", "-q");
    await git(cwd, "switch", "-qc", "other-checkout", parentSha);
    const second = await captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha });
    assert.equal(second.digest, first.digest);
    assert.equal(second.coverage, "complete");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("commit capture uses an explicit base directly and preserves deleted old-side hunks", async () => {
  const cwd = await repo();
  try {
    const baseSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    await writeFile(join(cwd, "intermediate.ts"), "export const intermediate = true;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "intermediate");
    const parentSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    await rm(join(cwd, "app.ts"));
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "delete app");
    const commitSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    await git(cwd, "switch", "-qc", "diverged-base", baseSha);
    await writeFile(join(cwd, "base-only.ts"), "export const base = true;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base only");
    const explicitBaseSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    const normal = await captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha });
    assert.equal(normal.baseSha, parentSha);
    assert.deepEqual(normal.files.map(file => file.path), ["app.ts"]);
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha, baseRef: "diverged-base" });
    assert.equal(snapshot.baseSha, explicitBaseSha);
    assert.deepEqual(snapshot.files.map(file => file.path), ["app.ts", "base-only.ts", "intermediate.ts"]);
    const deleted = snapshot.files.find(file => file.path === "app.ts")!;
    assert.equal(deleted.kind, "deleted");
    assert.equal(codeAssessmentHunkContent(deleted.diff, "old").get(1), "export const value = 1;");
    assert.equal(codeAssessmentHunkContent(deleted.diff, "new").size, 0);
    assert.notEqual(snapshot.digest, normal.digest);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("root commits compare against the empty tree without writing repository objects", async () => {
  const cwd = await repo();
  try {
    const commitSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    const objectsBefore = await git(cwd, "count-objects", "-v");
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha });
    assert.equal(snapshot.baseSha, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    assert.equal(snapshot.files[0]?.kind, "added");
    assert.equal(codeAssessmentHunkContent(snapshot.files[0]!.diff, "old").size, 0);
    assert.equal(codeAssessmentHunkContent(snapshot.files[0]!.diff, "new").get(1), "export const value = 1;");
    assert.equal(await git(cwd, "count-objects", "-v"), objectsBefore);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("merge commits default to their first parent", async () => {
  const cwd = await repo();
  try {
    await git(cwd, "switch", "-qc", "feature");
    await writeFile(join(cwd, "feature.ts"), "export const feature = true;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "feature");
    await git(cwd, "switch", "-q", "main");
    await writeFile(join(cwd, "main.ts"), "export const main = true;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "main");
    const firstParent = (await git(cwd, "rev-parse", "HEAD")).trim();
    await git(cwd, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const commitSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha });
    assert.equal(snapshot.baseSha, firstParent);
    assert.deepEqual(snapshot.files.map(file => file.path), ["feature.ts"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("shallow commits with unavailable parents fail instead of comparing as root commits", async () => {
  const cwd = await repo();
  const shallow = await mkdtemp(join(tmpdir(), "ling-assessment-shallow-"));
  try {
    await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "second");
    await git(cwd, "clone", "-q", "--depth", "1", `file://${cwd}`, shallow);
    const commitSha = (await git(shallow, "rev-parse", "HEAD")).trim();
    await assert.rejects(captureCodeAssessmentSnapshot(shallow, { type: "commit", commitSha }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(shallow, { recursive: true, force: true });
  }
});

test("commit capture rejects invalid SHAs, non-commit objects and unavailable base refs", async () => {
  const cwd = await repo();
  try {
    const commitSha = (await git(cwd, "rev-parse", "HEAD")).trim();
    const blobSha = (await git(cwd, "rev-parse", "HEAD:app.ts")).trim();
    await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha: "HEAD" }), /commitSha/u);
    await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha: "0".repeat(40) }));
    await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha: blobSha }));
    await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha, baseRef: "missing" }));
    await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "commit", commitSha, baseRef: "--output=bad" }), /baseRef/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
