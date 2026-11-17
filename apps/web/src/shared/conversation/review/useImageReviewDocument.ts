import { useEffect, useRef, useState } from "react";
import { artifactContentUrl } from "../../../api.js";
import { imageCanvasSize, parseImageEditDraft, validateImageSize, type ImageEditDraft } from "./image-drawing.js";
import { reviewStorage } from "./review-draft.js";

async function loadImage(url: string, signal?: AbortSignal, validateResult = false): Promise<{ image: HTMLImageElement; release: () => void }> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`Image load failed (${response.status})`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (validateResult) validateImageSize(image.naturalWidth, image.naturalHeight);
    return { image, release: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) { URL.revokeObjectURL(objectUrl); throw error; }
}

export function useImageReviewDocument(key: string, originalUrl: string, cwd?: string, onImageError?: () => void) {
  const [draft, setDraft] = useState<ImageEditDraft>(() => {
    try { return parseImageEditDraft(JSON.parse(reviewStorage()?.getItem(key) ?? "null")); }
    catch { return parseImageEditDraft(undefined); }
  });
  const initialDraft = useRef(draft);
  const [image, setImage] = useState<HTMLImageElement>();
  const [imageUrl, setImageUrl] = useState(() => draft.artifactId ? artifactContentUrl(draft.artifactId, cwd) : originalUrl);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const alive = useRef(true);
  const releaseImage = useRef<(() => void) | undefined>(undefined);

  function adopt(loaded: Awaited<ReturnType<typeof loadImage>>, url: string): void {
    releaseImage.current?.();
    releaseImage.current = loaded.release;
    setImage(loaded.image);
    setImageUrl(url);
  }

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const url = initialDraft.current.artifactId ? artifactContentUrl(initialDraft.current.artifactId, cwd) : originalUrl;
    void loadImage(url, controller.signal, Boolean(initialDraft.current.artifactId)).then(loaded => {
      if (controller.signal.aborted) { loaded.release(); return; }
      adopt(loaded, url);
      const size = imageCanvasSize(loaded.image.naturalWidth, loaded.image.naturalHeight);
      setDraft(current => ({ ...current, size: current.size ?? size,
        width: current.width || String(size.width), height: current.height || String(size.height) }));
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      if (!initialDraft.current.artifactId) onImageError?.();
    });
    return () => { alive.current = false; controller.abort(); releaseImage.current?.(); releaseImage.current = undefined; };
  }, [key]);

  useEffect(() => {
    try {
      const storage = reviewStorage();
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(key, JSON.stringify(draft));
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [key, draft]);

  async function replaceImage(url: string, artifactId?: string): Promise<boolean> {
    // Decode before changing the base or history so an unusable result preserves the draft.
    const loaded = await loadImage(url, undefined, Boolean(artifactId));
    if (!alive.current) { loaded.release(); return false; }
    adopt(loaded, url);
    const size = imageCanvasSize(loaded.image.naturalWidth, loaded.image.naturalHeight);
    setDraft(current => ({ ...current, artifactId, history: [], cursor: 0, size, width: String(size.width), height: String(size.height), point: undefined }));
    return true;
  }

  return { draft, setDraft, image, imageUrl, error, setError, storageError, alive, replaceImage };
}
