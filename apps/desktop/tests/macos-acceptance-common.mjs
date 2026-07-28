import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const RELEASE_HARNESS_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const MACOS_RELEASE_ARCHITECTURES = Object.freeze(["arm64"]);
export const MACOS_TCC_CASE_IDS = Object.freeze([
  "denied",
  "prompt",
  "granted",
  "revoked",
]);
export const LING_DESKTOP_BUNDLE_ID = "com.lingstack.desktop";
export const MACOS_SYSTEM_TOOLS = Object.freeze({
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  git: "/usr/bin/git",
  lipo: "/usr/bin/lipo",
  plutil: "/usr/bin/plutil",
  ps: "/bin/ps",
  spctl: "/usr/sbin/spctl",
  swVers: "/usr/bin/sw_vers",
  unzip: "/usr/bin/unzip",
  xcrun: "/usr/bin/xcrun",
});

export function macosSystemTool(name) {
  const path = MACOS_SYSTEM_TOOLS[name];
  if (!path) {
    throw new Error(`macos_acceptance_system_tool_unknown:${name}`);
  }
  return path;
}

export function normalizeMacosArchitecture(value) {
  if (value === "x64" || value === "x86_64") {
    return "x86_64";
  }
  if (value === "arm64") {
    return "arm64";
  }
  return undefined;
}

export async function captureMacosReleaseHarnessProvenance(
  scriptPaths,
  { repoRoot = RELEASE_HARNESS_REPO_ROOT } = {},
) {
  if (process.platform !== "darwin") {
    throw new Error("macos_release_harness_requires_darwin");
  }
  const resolvedRepoRoot = await realpath(repoRoot);
  await assertMacosReleaseHarnessRepositoryRoot(resolvedRepoRoot);
  await assertMacosReleaseHarnessWorktreeClean(resolvedRepoRoot);
  const revision = await execFileAsync(
    macosSystemTool("git"),
    ["rev-parse", "HEAD"],
    { cwd: resolvedRepoRoot, encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  const commit = revision.stdout.trim().toLowerCase();
  if (!GIT_OBJECT_ID_PATTERN.test(commit)) {
    throw new Error("macos_release_harness_commit_invalid");
  }
  const provenance = await buildReleaseHarnessProvenance(
    commit,
    scriptPaths,
    resolvedRepoRoot,
  );
  await assertMacosReleaseHarnessWorktreeClean(resolvedRepoRoot);
  return provenance;
}

export async function buildReleaseHarnessProvenance(
  commit,
  scriptPaths,
  repoRoot = RELEASE_HARNESS_REPO_ROOT,
) {
  if (!GIT_OBJECT_ID_PATTERN.test(commit ?? "")) {
    throw new Error("macos_release_harness_commit_invalid");
  }
  if (!Array.isArray(scriptPaths) || scriptPaths.length === 0) {
    throw new Error("macos_release_harness_scripts_invalid");
  }
  const resolvedRepoRoot = await realpath(repoRoot);
  await assertMacosReleaseHarnessRepositoryRoot(resolvedRepoRoot);
  const revision = await execFileAsync(
    macosSystemTool("git"),
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { cwd: resolvedRepoRoot, encoding: "utf8", maxBuffer: 64 * 1024 },
  ).catch(() => {
    throw new Error("macos_release_harness_commit_invalid");
  });
  if (revision.stdout.trim().toLowerCase() !== commit) {
    throw new Error("macos_release_harness_commit_invalid");
  }
  const files = [];
  const seenPaths = new Set();
  for (const scriptPath of scriptPaths) {
    if (!nonEmptyString(scriptPath)) {
      throw new Error("macos_release_harness_scripts_invalid");
    }
    const path = await realpath(
      isAbsolute(scriptPath)
        ? scriptPath
        : resolve(resolvedRepoRoot, scriptPath),
    ).catch(() => {
      throw new Error("macos_release_harness_script_invalid");
    });
    const relativePath = relative(resolvedRepoRoot, path);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error("macos_release_harness_script_outside_repository");
    }
    const repositoryPath = relativePath.split(sep).join("/");
    if (seenPaths.has(repositoryPath)) {
      throw new Error(`macos_release_harness_script_duplicate:${repositoryPath}`);
    }
    seenPaths.add(repositoryPath);
    let committedObjectId;
    let workingObjectId;
    let contentObjectId;
    let bytes;
    try {
      const committed = await execFileAsync(
        macosSystemTool("git"),
        ["rev-parse", "--verify", `${commit}:${repositoryPath}`],
        { cwd: resolvedRepoRoot, encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      const working = await execFileAsync(
        macosSystemTool("git"),
        ["hash-object", `--path=${repositoryPath}`, path],
        { cwd: resolvedRepoRoot, encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      // Rehash the same bytes used for the raw SHA-256 so a concurrent file
      // replacement cannot leave internally inconsistent provenance.
      bytes = await readFile(path);
      const content = execFileSync(
        macosSystemTool("git"),
        ["hash-object", "--stdin", `--path=${repositoryPath}`],
        {
          cwd: resolvedRepoRoot,
          encoding: "utf8",
          input: bytes,
          maxBuffer: 64 * 1024,
        },
      );
      committedObjectId = committed.stdout.trim().toLowerCase();
      workingObjectId = working.stdout.trim().toLowerCase();
      contentObjectId = content.trim().toLowerCase();
    } catch {
      throw new Error(
        `macos_release_harness_commit_blob_missing:${repositoryPath}`,
      );
    }
    if (
      !GIT_OBJECT_ID_PATTERN.test(committedObjectId) ||
      !GIT_OBJECT_ID_PATTERN.test(workingObjectId) ||
      !GIT_OBJECT_ID_PATTERN.test(contentObjectId) ||
      committedObjectId !== workingObjectId ||
      committedObjectId !== contentObjectId
    ) {
      throw new Error(
        `macos_release_harness_commit_blob_mismatch:${repositoryPath}`,
      );
    }
    files.push({
      path: repositoryPath,
      sha256: sha256Buffer(bytes),
      gitBlobObjectId: committedObjectId,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { commit, files };
}

export function assertReleaseHarnessProvenance(
  actual,
  expected,
  requiredPaths,
  label = "harness",
) {
  if (
    !GIT_OBJECT_ID_PATTERN.test(actual?.commit ?? "") ||
    actual.commit !== expected?.commit ||
    !Array.isArray(requiredPaths) ||
    requiredPaths.length === 0
  ) {
    throw new Error(`macos_release_harness_binding_invalid:${label}`);
  }
  const actualFiles = releaseHarnessFileIndex(actual.files, label);
  const expectedFiles = releaseHarnessFileIndex(expected?.files, label);
  const seenRequiredPaths = new Set();
  for (const path of requiredPaths) {
    if (
      !validReleaseHarnessRepositoryPath(path) ||
      seenRequiredPaths.has(path)
    ) {
      throw new Error(`macos_release_harness_binding_invalid:${label}:${path}`);
    }
    seenRequiredPaths.add(path);
    const actualFile = actualFiles.get(path);
    const expectedFile = expectedFiles.get(path);
    if (
      !actualFile ||
      !expectedFile ||
      actualFile.sha256 !== expectedFile.sha256 ||
      actualFile.gitBlobObjectId !== expectedFile.gitBlobObjectId
    ) {
      throw new Error(`macos_release_harness_binding_invalid:${label}:${path}`);
    }
  }
  return actual;
}

export function reportRelativePath(reportDirectory, targetPath) {
  const value = relative(resolve(reportDirectory), resolve(targetPath));
  return (value || ".").split(sep).join("/");
}

export function resolveReportRelativePath(reportPath, value, label = "path") {
  if (!nonEmptyString(value) || isAbsolute(value)) {
    throw new Error(`macos_acceptance_relative_path_invalid:${label}`);
  }
  return resolve(dirname(resolve(reportPath)), value);
}

export async function canonicalReportRelativePath(reportPath, value, label = "path") {
  return realpath(resolveReportRelativePath(reportPath, value, label));
}

export async function verifyEvidenceReference(
  value,
  reportPath,
  label,
  { parseJson = false } = {},
) {
  if (
    !nonEmptyString(value?.path) ||
    isAbsolute(value.path) ||
    !/^[0-9a-f]{64}$/u.test(value?.sha256 ?? "")
  ) {
    throw new Error(`macos_acceptance_evidence_reference_invalid:${label}`);
  }
  const path = await canonicalReportRelativePath(reportPath, value.path, label);
  const bytes = await readFile(path);
  const sha256 = sha256Buffer(bytes);
  if (sha256 !== value.sha256) {
    throw new Error(`macos_acceptance_evidence_hash_mismatch:${label}`);
  }
  let json;
  if (parseJson) {
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`macos_acceptance_evidence_json_invalid:${label}`);
    }
  }
  return {
    reference: {
      path: reportRelativePath(dirname(resolve(reportPath)), path),
      sha256,
    },
    path,
    sha256,
    bytes,
    json,
  };
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validDateTime(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

export function sameEvidenceReference(left, right) {
  return left?.path === right?.path && left?.sha256 === right?.sha256;
}

async function assertMacosReleaseHarnessRepositoryRoot(repoRoot) {
  const root = await execFileAsync(
    macosSystemTool("git"),
    ["rev-parse", "--show-toplevel"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 },
  ).catch(() => {
    throw new Error("macos_release_harness_repository_invalid");
  });
  const gitRoot = await realpath(root.stdout.trim()).catch(() => {
    throw new Error("macos_release_harness_repository_invalid");
  });
  if (gitRoot !== repoRoot) {
    throw new Error("macos_release_harness_repository_root_mismatch");
  }
}

async function assertMacosReleaseHarnessWorktreeClean(repoRoot) {
  const status = await execFileAsync(
    macosSystemTool("git"),
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  ).catch(() => {
    throw new Error("macos_release_harness_repository_invalid");
  });
  if (status.stdout.trim().length > 0) {
    throw new Error("macos_release_harness_worktree_dirty");
  }
}

function releaseHarnessFileIndex(files, label) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`macos_release_harness_binding_invalid:${label}`);
  }
  const index = new Map();
  for (const file of files) {
    if (
      !validReleaseHarnessRepositoryPath(file?.path) ||
      !SHA256_PATTERN.test(file?.sha256 ?? "") ||
      !GIT_OBJECT_ID_PATTERN.test(file?.gitBlobObjectId ?? "") ||
      index.has(file.path)
    ) {
      throw new Error(
        `macos_release_harness_binding_invalid:${label}:${file?.path ?? "unknown"}`,
      );
    }
    index.set(file.path, file);
  }
  return index;
}

function validReleaseHarnessRepositoryPath(value) {
  return (
    nonEmptyString(value) &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    value !== ".." &&
    !value.startsWith("../") &&
    !value.startsWith("./") &&
    !value.includes("/../") &&
    !value.includes("/./") &&
    !value.endsWith("/..") &&
    !value.endsWith("/.")
  );
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}
