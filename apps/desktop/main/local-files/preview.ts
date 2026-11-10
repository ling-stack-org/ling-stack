import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopLocalFilePreview, DesktopLocalFileRequest } from "../../shared/local-file-capabilities.js";

export const LOCAL_FILE_TEXT_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const DIRECTORY_LIMIT = 500;
const imageTypes: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif" };
const languages: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".java": "java", ".kt": "kotlin", ".rs": "rust", ".go": "go", ".c": "c", ".h": "c", ".cpp": "cpp",
  ".json": "json", ".md": "markdown", ".css": "css", ".html": "html", ".xml": "xml", ".yaml": "yaml", ".yml": "yaml", ".sh": "bash", ".sql": "sql",
};
const binaryExtensions = new Set([".zip", ".rar", ".7z", ".gz", ".tar", ".bz2", ".xz", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".exe", ".dll", ".dmg", ".pkg", ".mp3", ".mp4", ".mov", ".woff", ".woff2", ".sqlite", ".db"]);

export async function resolveLocalFilePath(request: DesktopLocalFileRequest): Promise<string> {
  if (!request || typeof request.path !== "string" || !request.path.trim() || request.path.length > 32_768 || request.path.includes("\0")) throw new Error("local_file_invalid_path");
  let path = request.path;
  if (path.startsWith("file:")) path = fileURLToPath(path);
  else if (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[A-Z]:[\\/]/iu.test(path)) throw new Error("local_file_invalid_path");
  // Network shares are not local files and may initiate implicit authentication.
  if (path.startsWith("\\\\") || path.startsWith("//") || request.cwd?.startsWith("\\\\") || request.cwd?.startsWith("//")) throw new Error("local_file_invalid_path");
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path) && (!request.cwd || !isAbsolute(request.cwd))) throw new Error("local_file_invalid_path");
  const candidate = isAbsolute(path) ? path : resolve(request.cwd!, path);
  if (candidate.startsWith("\\\\") || candidate.startsWith("//")) throw new Error("local_file_invalid_path");
  return realpath(candidate);
}

export async function inspectLocalFile(request: DesktopLocalFileRequest): Promise<DesktopLocalFilePreview> {
  const path = await resolveLocalFilePath(request);
  const metadata = await stat(path);
  const base = { path, name: basename(path) || path, sizeBytes: metadata.size, line: request.line, truncated: false };
  if (metadata.isDirectory()) {
    const entries: NonNullable<DesktopLocalFilePreview["entries"]>[number][] = [];
    const directory = await opendir(path);
    let truncated = false;
    for await (const entry of directory) {
      if (entries.length === DIRECTORY_LIMIT) { truncated = true; break; }
      entries.push({ name: entry.name, path: join(path, entry.name), directory: entry.isDirectory() });
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { ...base, kind: "directory", entries, truncated };
  }
  if (!metadata.isFile()) throw new Error("local_file_not_regular");
  const extension = extname(path).toLowerCase();
  if (binaryExtensions.has(extension)) return { ...base, kind: "unsupported" };
  const imageType = imageTypes[extension];
  if (imageType && metadata.size > IMAGE_LIMIT) return { ...base, kind: "unsupported" };
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.dev !== metadata.dev || current.ino !== metadata.ino) throw new Error("local_file_changed");
    const limit = imageType ? IMAGE_LIMIT : LOCAL_FILE_TEXT_LIMIT;
    const buffer = Buffer.alloc(Math.min(current.size, limit) + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const truncated = current.size > limit || bytesRead > limit;
    const bytes = buffer.subarray(0, Math.min(bytesRead, limit));
    if (imageType) return truncated ? { ...base, kind: "unsupported" } : { ...base, kind: "image", imageUrl: `data:${imageType};base64,${bytes.toString("base64")}` };
    if (bytes.includes(0)) return { ...base, kind: "unsupported" };
    try {
      // stream leaves a split final UTF-8 character buffered on a truncated read.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
      return { ...base, kind: "text", text, language: languages[extension] ?? "text", truncated };
    } catch { return { ...base, kind: "unsupported" }; }
  } finally { await file.close(); }
}
