import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface MediaProjectPendingImageUpload {
  readonly id: string;
  readonly projectId: string;
  readonly sceneId: string;
  readonly file: File;
  readonly previewUrl: string;
  readonly state: "uploading" | "failed";
  readonly messageKey?: string;
  readonly technicalMessage?: string;
}

export interface MediaProjectImageUploadState {
  readonly uploads: readonly MediaProjectPendingImageUpload[];
  readonly pendingSceneIds: ReadonlySet<string>;
  readonly add: (
    projectId: string,
    sceneId: string,
    files: readonly File[],
  ) => readonly MediaProjectPendingImageUpload[];
  readonly update: (
    uploadId: string,
    patch: Partial<Pick<MediaProjectPendingImageUpload, "state" | "messageKey" | "technicalMessage">>,
  ) => void;
  readonly remove: (uploadId: string) => void;
}

export function useMediaProjectImageUploads(input: {
  readonly cwd: string;
  readonly projectId: string;
  readonly sceneIds: readonly string[];
}): MediaProjectImageUploadState {
  const [uploads, setUploads] = useState<readonly MediaProjectPendingImageUpload[]>([]);
  const uploadsRef = useRef(uploads);
  const mountedRef = useRef(true);
  const sceneSignature = input.sceneIds.join("\u0000");

  const commit = useCallback((update: (
    current: readonly MediaProjectPendingImageUpload[],
  ) => readonly MediaProjectPendingImageUpload[]): void => {
    if (!mountedRef.current) return;
    const next = update(uploadsRef.current);
    uploadsRef.current = next;
    setUploads(next);
  }, []);

  const clear = useCallback((keep?: (upload: MediaProjectPendingImageUpload) => boolean): void => {
    commit((current) => {
      const retained = keep ? current.filter(keep) : [];
      const retainedIds = new Set(retained.map((upload) => upload.id));
      for (const upload of current) {
        if (!retainedIds.has(upload.id)) releasePreview(upload.previewUrl);
      }
      return retained;
    });
  }, [commit]);

  useEffect(() => {
    clear();
  }, [clear, input.cwd, input.projectId]);

  useEffect(() => {
    const sceneIds = new Set(input.sceneIds);
    clear((upload) => sceneIds.has(upload.sceneId));
  }, [clear, sceneSignature]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const upload of uploadsRef.current) releasePreview(upload.previewUrl);
      uploadsRef.current = [];
    };
  }, []);

  const add = useCallback((
    projectId: string,
    sceneId: string,
    files: readonly File[],
  ): readonly MediaProjectPendingImageUpload[] => {
    if (!mountedRef.current || uploadsRef.current.some((upload) => upload.sceneId === sceneId && upload.state === "uploading")) {
      return [];
    }
    const pending = files.map<MediaProjectPendingImageUpload>((file) => ({
      id: createPendingId(),
      projectId,
      sceneId,
      file,
      previewUrl: URL.createObjectURL(file),
      state: "uploading",
    }));
    commit((current) => [...current, ...pending]);
    return pending;
  }, [commit]);

  const update = useCallback((
    uploadId: string,
    patch: Partial<Pick<MediaProjectPendingImageUpload, "state" | "messageKey" | "technicalMessage">>,
  ): void => {
    commit((current) => current.map((upload) => upload.id === uploadId ? { ...upload, ...patch } : upload));
  }, [commit]);

  const remove = useCallback((uploadId: string): void => {
    commit((current) => {
      const target = current.find((upload) => upload.id === uploadId);
      if (target) releasePreview(target.previewUrl);
      return current.filter((upload) => upload.id !== uploadId);
    });
  }, [commit]);

  const pendingSceneIds = useMemo<ReadonlySet<string>>(
    () => new Set(uploads.map((upload) => upload.sceneId)),
    [uploads],
  );

  return { uploads, pendingSceneIds, add, update, remove };
}

function createPendingId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function releasePreview(url: string): void {
  if (url) URL.revokeObjectURL(url);
}
