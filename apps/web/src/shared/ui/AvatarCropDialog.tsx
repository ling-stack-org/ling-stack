import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
} from "@ling-stack/ui-react";

const CROP_SIZE = 280;
const OUTPUT_SIZES = [512, 448, 384, 320, 256, 192] as const;
const OUTPUT_QUALITIES = [0.92, 0.84, 0.76, 0.68] as const;
const TARGET_DATA_URL_LENGTH = 240 * 1024;

export interface AvatarCropDialogProps {
  readonly sourceDataUrl: string;
  readonly onCancel: () => void;
  readonly onConfirm: (avatarDataUrl: string) => void | Promise<void>;
}

interface ImageSize {
  readonly width: number;
  readonly height: number;
}

interface CropOffset {
  readonly x: number;
  readonly y: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startOffset: CropOffset;
}

export function AvatarCropDialog({ sourceDataUrl, onCancel, onConfirm }: AvatarCropDialogProps): JSX.Element {
  const { t } = useI18n();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cropFrameRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize | undefined>();
  const [cropSize, setCropSize] = useState(CROP_SIZE);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<CropOffset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.addEventListener("load", () => {
      if (cancelled) {
        return;
      }
      imageRef.current = image;
      setImageSize({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
      setOffset({ x: 0, y: 0 });
      setZoom(1);
      setError("");
    });
    image.addEventListener("error", () => {
      if (!cancelled) {
        setError(t("The image could not be read. Choose another image."));
      }
    });
    image.src = sourceDataUrl;
    return () => {
      cancelled = true;
    };
  }, [sourceDataUrl, t]);

  useEffect(() => {
    const element = cropFrameRef.current;
    if (!element) {
      return;
    }
    const updateCropSize = (): void => {
      setCropSize(Math.round(element.getBoundingClientRect().width));
    };
    updateCropSize();
    const observer = new ResizeObserver(updateCropSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (imageSize) {
      setOffset((current) => clampOffset(current, imageSize, zoom, cropSize));
    }
  }, [cropSize, imageSize, zoom]);

  const renderedImage = useMemo(() => {
    if (!imageSize) {
      return undefined;
    }
    const scale = scaleForZoom(imageSize, zoom, cropSize);
    return {
      width: imageSize.width * scale,
      height: imageSize.height * scale,
    };
  }, [cropSize, imageSize, zoom]);

  function updateZoom(value: number): void {
    if (!imageSize) {
      return;
    }
    const nextZoom = clamp(value, 1, 3);
    setZoom(nextZoom);
    setOffset((current) => clampOffset(current, imageSize, nextZoom, cropSize));
  }

  function startDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!imageSize) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offset,
    };
    setDragging(true);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!imageSize || dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    const nextOffset = {
      x: dragRef.current.startOffset.x + event.clientX - dragRef.current.startX,
      y: dragRef.current.startOffset.y + event.clientY - dragRef.current.startY,
    };
    setOffset(clampOffset(nextOffset, imageSize, zoom, cropSize));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  }

  async function confirmCrop(): Promise<void> {
    if (!imageRef.current || !imageSize || rendering) {
      return;
    }
    setRendering(true);
    setError("");
    try {
      await onConfirm(renderCroppedAvatar(
        imageRef.current,
        imageSize,
        zoom,
        offset,
        cropSize,
        t("This browser cannot crop the avatar."),
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRendering(false);
    }
  }

  return (
    <Dialog
      busy={rendering}
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="profile-crop-dialog"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
        }}
      >
        <DialogHeader title={t("Adjust avatar")} closeLabel={t("Close avatar crop")} />
        <DialogBody className="profile-crop-body">
          <div className="profile-crop-stage">
          <div
            ref={cropFrameRef}
            className={dragging ? "profile-crop-frame dragging" : "profile-crop-frame"}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            role="img"
            aria-label={t("Avatar crop preview")}
          >
            {renderedImage ? (
              <img
                className="profile-crop-image"
                src={sourceDataUrl}
                alt=""
                style={{
                  width: renderedImage.width,
                  height: renderedImage.height,
                  left: `calc(50% + ${offset.x}px)`,
                  top: `calc(50% + ${offset.y}px)`,
                }}
                draggable={false}
              />
            ) : (
              <span className="profile-crop-loading">{t("Loading avatar")}</span>
            )}
          </div>
          </div>

          <Field className="profile-crop-control" label={t("Zoom")}>
            <input
              data-ling-control-native="true"
              className="profile-crop-range"
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(event) => updateZoom(Number(event.target.value))}
              disabled={!imageSize}
            />
          </Field>

          {error ? (
            <InlineFeedback className="profile-crop-error" tone="danger" title={t("Avatar needs attention")}>
              {error}
            </InlineFeedback>
          ) : null}
        </DialogBody>

        <DialogFooter className="profile-crop-actions">
          <Button ref={cancelButtonRef} variant="secondary" onClick={onCancel} disabled={rendering}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            loading={rendering}
            loadingLabel={t("Processing")}
            onClick={() => void confirmCrop()}
            disabled={!imageSize}
          >
            {t("Use avatar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function renderCroppedAvatar(
  image: HTMLImageElement,
  imageSize: ImageSize,
  zoom: number,
  offset: CropOffset,
  cropSize: number,
  canvasUnavailableMessage: string,
): string {
  const scale = scaleForZoom(imageSize, zoom, cropSize);
  const sourceX = (imageSize.width * scale - cropSize - offset.x * 2) / (2 * scale);
  const sourceY = (imageSize.height * scale - cropSize - offset.y * 2) / (2 * scale);
  const sourceSize = cropSize / scale;
  const safeSourceSize = Math.min(sourceSize, imageSize.width, imageSize.height);
  let fallback = "";

  for (const outputSize of OUTPUT_SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error(canvasUnavailableMessage);
    }
    context.clearRect(0, 0, outputSize, outputSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.save();
    context.beginPath();
    context.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
    context.clip();
    context.drawImage(
      image,
      clamp(sourceX, 0, Math.max(0, imageSize.width - safeSourceSize)),
      clamp(sourceY, 0, Math.max(0, imageSize.height - safeSourceSize)),
      safeSourceSize,
      safeSourceSize,
      0,
      0,
      outputSize,
      outputSize,
    );
    context.restore();

    for (const quality of OUTPUT_QUALITIES) {
      const dataUrl = canvas.toDataURL("image/webp", quality);
      fallback = dataUrl;
      if (dataUrl.length <= TARGET_DATA_URL_LENGTH) {
        return dataUrl;
      }
    }
  }

  return fallback;
}

function scaleForZoom(imageSize: ImageSize, zoom: number, cropSize: number): number {
  return Math.max(cropSize / imageSize.width, cropSize / imageSize.height) * zoom;
}

function clampOffset(offset: CropOffset, imageSize: ImageSize, zoom: number, cropSize: number): CropOffset {
  const scale = scaleForZoom(imageSize, zoom, cropSize);
  const maxX = Math.max(0, (imageSize.width * scale - cropSize) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - cropSize) / 2);
  return {
    x: clamp(offset.x, -maxX, maxX),
    y: clamp(offset.y, -maxY, maxY),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
