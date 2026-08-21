import type { CreateMediaProjectAssetRequest } from "../../types.js";

const maxImageBytes = 25 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export type MediaProjectImageFileIssue = "unsupported_type" | "empty_file" | "file_too_large" | "read_failed";

export class MediaProjectImageFileError extends Error {
  readonly issue: MediaProjectImageFileIssue;

  constructor(issue: MediaProjectImageFileIssue) {
    super(issue);
    this.name = "MediaProjectImageFileError";
    this.issue = issue;
  }
}

export function validateMediaProjectImageFile(file: Pick<File, "size" | "type">): MediaProjectImageFileIssue | undefined {
  if (!allowedImageTypes.has(file.type)) return "unsupported_type";
  if (file.size <= 0) return "empty_file";
  if (file.size > maxImageBytes) return "file_too_large";
  return undefined;
}

export async function mediaProjectImageUploadRequest(file: File): Promise<CreateMediaProjectAssetRequest> {
  const issue = validateMediaProjectImageFile(file);
  if (issue) throw new MediaProjectImageFileError(issue);
  const contentBase64 = await readFileBase64(file);
  return {
    kind: "upload",
    fileName: file.name,
    contentType: file.type,
    contentBase64,
  };
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new MediaProjectImageFileError("read_failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new MediaProjectImageFileError("read_failed"));
        return;
      }
      const separatorIndex = result.indexOf(",");
      if (separatorIndex < 0 || separatorIndex === result.length - 1) {
        reject(new MediaProjectImageFileError("read_failed"));
        return;
      }
      resolve(result.slice(separatorIndex + 1));
    };
    reader.readAsDataURL(file);
  });
}
