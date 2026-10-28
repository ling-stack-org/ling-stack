import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createSkillSourceSnapshotId, type CreateSkillSourceArtifactInput, type PublishSkillSourceBatchInput,
  type RunStore, type SkillSourceSyncPreviewRecord } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
};

function mediaType(extension: string): string | undefined {
  const value = extension.toLowerCase();
  if ([".md", ".markdown"].includes(value)) return "text/markdown; charset=utf-8";
  if (value === ".json") return "application/json; charset=utf-8";
  if ([".yaml", ".yml"].includes(value)) return "text/yaml; charset=utf-8";
  if ([".txt", ".sh", ".ts", ".tsx", ".js", ".jsx", ".py"].includes(value)) return "text/plain; charset=utf-8";
  return undefined;
}

/** Stage verified bytes first; no source or registry row becomes visible before commit. */
export async function prepareSkillSourcePublication(store: RunStore, records: readonly SkillSourceSyncPreviewRecord[],
  publishArtifacts: boolean) {
  const directories = new Map<string, string>();
  let totalBytes = 0;
  const cleanup = async (retained: ReadonlySet<string> = new Set()) => {
    for (const [id, path] of directories) {
      if (!retained.has(id)) await rm(path, { recursive: true, force: true });
    }
  };
  try {
    const prepared: PublishSkillSourceBatchInput["records"][number][] = [];
    for (const record of records) {
      if (!record.snapshotPreview) throw new HttpError(409, "skill_source_sync_missing_snapshot", `Missing source: ${record.skillId}`);
      const sourceDigest = `sha256:${createHash("sha256").update(record.snapshotPreview.rawSkillMarkdown).digest("hex")}`;
      if (sourceDigest !== record.snapshotPreview.sourceChecksum || record.warnings.some(warning => warning.code === "source_truncated")) {
        throw new HttpError(409, "skill_source_incomplete", "Refusing to publish truncated or corrupt source instructions");
      }
      const id = createSkillSourceSnapshotId();
      const artifacts: CreateSkillSourceArtifactInput[] = [];
      if (record.sourcePath && record.state !== "unchanged") {
        const sourceRoot = await realpath(dirname(record.sourcePath));
        let artifactsRoot: string | undefined;
        if (publishArtifacts) {
          artifactsRoot = await realpath(store.paths.artifactsDir);
          const stageRoot = join(artifactsRoot, "skill-source");
          await mkdir(stageRoot, { recursive: true });
          if (await realpath(stageRoot) !== stageRoot) throw new HttpError(409, "skill_source_artifact_path_escape", "Artifact root contains a symlink");
          const directory = join(stageRoot, id);
          await mkdir(directory);
          directories.set(id, directory);
        }
        const files = [{ path: "SKILL.md", kind: "other" as const,
          checksum: record.sourceChecksum, sizeBytes: record.sourceSizeBytes },
          // With artifact staging disabled, referenced files are neither read
          // nor copied anywhere — skip their realpath/size/checksum/budget
          // validation instead of rejecting publishArtifacts:false callers.
          ...(publishArtifacts ? record.referencedFiles : [])];
        for (const file of files) {
          if (!file.checksum || file.sizeBytes === undefined) {
            throw new HttpError(409, "skill_source_artifact_unverified", `Unverified resource: ${file.path}`);
          }
          const source = resolve(sourceRoot, file.path);
          if (!inside(sourceRoot, source) || await realpath(source) !== source) {
            throw new HttpError(409, "skill_source_artifact_source_escape", `Invalid resource: ${file.path}`);
          }
          const info = await lstat(source);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes || info.size > MAX_FILE_BYTES ||
            totalBytes + info.size > MAX_BATCH_BYTES) {
            throw new HttpError(409, "skill_source_artifact_budget_or_size", `Invalid resource size: ${file.path}`);
          }
          const handle = await open(source, "r");
          let bytes: Buffer;
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) {
              throw new HttpError(409, "skill_source_artifact_changed", `Source changed after preview: ${file.path}`);
            }
            const chunks: Buffer[] = [];
            let count = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
              count += chunk.length;
              if (count > file.sizeBytes) throw new HttpError(409, "skill_source_artifact_changed", `Source grew after preview: ${file.path}`);
              chunks.push(chunk);
            }
            bytes = Buffer.concat(chunks, count);
          } finally { await handle.close(); }
          totalBytes += bytes.length;
          const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          if (bytes.length !== file.sizeBytes || checksum !== file.checksum) {
            throw new HttpError(409, "skill_source_artifact_changed", `Source changed after preview: ${file.path}`);
          }
          if (file.path === "SKILL.md" && bytes.toString("utf8") !== record.snapshotPreview.rawSkillMarkdown) {
            throw new HttpError(409, "skill_source_incomplete", "Refusing to publish truncated source instructions");
          }
          if (artifactsRoot) {
            const extension = extname(file.path);
            const name = basename(file.path, extension).replace(/[^a-zA-Z0-9._-]/g, "-") || "source";
            const storageRef = ["skill-source", id, `${artifacts.length}-${checksum.slice(7, 39)}-${name}${extension}`].join("/");
            await writeFile(resolve(artifactsRoot, storageRef), bytes, { flag: "wx" });
            artifacts.push({ snapshotId: id, path: file.path, kind: file.kind, checksum, sizeBytes: bytes.length,
              storageRef, mediaType: mediaType(extension),
              reviewStatus: file.kind === "script" || file.kind === "asset" ? "reviewed" : "published",
              includedInRuntime: file.kind === "reference" || file.kind === "agent-metadata" });
          }
        }
      }
      prepared.push({ snapshot: { ...record.snapshotPreview, id },
        expectedSnapshotId: record.existingSnapshotId, expectedSourceChecksum: record.existingSnapshotChecksum, artifacts });
    }
    return { records: prepared, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
