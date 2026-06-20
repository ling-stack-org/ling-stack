import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { X } from "lucide-react";

const CROP_SIZE = 280;
const OUTPUT_SIZES = [512, 448, 384, 320, 256, 192] as const;
const OUTPUT_QUALITIES = [0.92, 0.84, 0.76, 0.68] as const;
const TARGET_DATA_URL_LENGTH = 240 * 1024;

interface AvatarCropDialogProps {
  readonly sourceDataUrl: string;
  readonly onCancel: () => void;
  readonly onConfirm: (avatarDataUrl: string) => void;
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
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cropFrameRef = useRef<HTMLDivElement | null>(null);
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
        setError("图片无法读取，请换一张图片。");
      }
    });
    image.src = sourceDataUrl;
    return () => {
      cancelled = true;
    };
  }, [sourceDataUrl]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

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
      onConfirm(renderCroppedAvatar(imageRef.current, imageSize, zoom, offset, cropSize));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="profile-crop-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="profile-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-crop-title">
        <div className="profile-crop-head">
          <h2 id="profile-crop-title">调整头像</h2>
          <button className="icon-button" type="button" onClick={onCancel} aria-label="关闭头像调整">
            <X size={16} />
          </button>
        </div>

        <div className="profile-crop-stage">
          <div
            ref={cropFrameRef}
            className={dragging ? "profile-crop-frame dragging" : "profile-crop-frame"}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            role="img"
            aria-label="头像裁剪预览"
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
              <span className="profile-crop-loading">载入中</span>
            )}
          </div>
        </div>

        <label className="profile-crop-control">
          <span>缩放</span>
          <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(event) => updateZoom(Number(event.target.value))} disabled={!imageSize} />
        </label>

        {error ? <p className="profile-crop-error">{error}</p> : null}

        <div className="profile-crop-actions">
          <button className="secondary-button compact-button" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => void confirmCrop()} disabled={!imageSize || rendering}>
            {rendering ? "处理中" : "使用头像"}
          </button>
        </div>
      </section>
    </div>
  );
}

function renderCroppedAvatar(image: HTMLImageElement, imageSize: ImageSize, zoom: number, offset: CropOffset, cropSize: number): string {
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
      throw new Error("当前浏览器无法处理头像裁剪。");
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
