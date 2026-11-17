import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { PreviewContentResponse, ProviderPreset } from "@ling-stack/contracts";
import { useI18n } from "../../../i18n.js";
import { Button, Checkbox, Input, Textarea, Select, InlineFeedback } from "../../ui/index.js";
import { ImageCompareViewer } from "../preview/ImageCompareViewer.js";
import { useReviewDraft } from "./ReviewDraftContext.js";
import {
  appendImageDrawing, canvasImageFile, drawImageDrawing, imageCanvasSize, imagePoint, renderEditedImage, validateImageSize,
  type ImageDrawing, type ImageEditMode,
} from "./image-drawing.js";
import { imageEditProviders, runImageEdit } from "./image-edit-service.js";
import { useImageReviewDocument } from "./useImageReviewDocument.js";

const modes: readonly { id: ImageEditMode; label: string }[] = [
  { id: "preview", label: "Preview" }, { id: "comment", label: "Comment" }, { id: "brush", label: "Brush" }, { id: "line", label: "Line" },
  { id: "arrow", label: "Arrow" }, { id: "rectangle", label: "Rectangle" }, { id: "ellipse", label: "Ellipse" },
  { id: "text", label: "Text" }, { id: "eraser", label: "Erase pixels" },
];
interface ImageReviewEditorProps {
  readonly preview: PreviewContentResponse;
  readonly cwd?: string;
  readonly onImageError?: () => void;
}

export function ImageReviewEditor(props: ImageReviewEditorProps): React.JSX.Element {
  const review = useReviewDraft();
  const key = `ling-stack.image-review:${JSON.stringify([review?.owner, props.cwd, props.preview.ref.source, props.preview.ref.scope, props.preview.ref.id])}`;
  return <ImageReviewSurface key={key} {...props} draftKey={key} />;
}

function ImageReviewSurface({ preview, cwd, onImageError, draftKey }: ImageReviewEditorProps & { readonly draftKey: string }): React.JSX.Element {
  const { t } = useI18n();
  const review = useReviewDraft();
  const { draft, setDraft, image, imageUrl, error, setError, storageError, alive, replaceImage } = useImageReviewDocument(draftKey, preview.imageUrl!, cwd, onImageError);
  const { history, cursor, mode, color, strokeWidth, text, point, comment, width, height, keepRatio, artifactId } = draft;
  const size = draft.size ?? { width: 1, height: 1 };
  const activeDrawings = history.slice(0, cursor);
  const [drawing, setDrawing] = useState<ImageDrawing>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [providers, setProviders] = useState<readonly ProviderPreset[]>([]);
  const [providerId, setProviderId] = useState("");
  const [providerError, setProviderError] = useState("");
  const [compare, setCompare] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<{ id: number; drawing: ImageDrawing } | undefined>(undefined);
  const attachedSnapshot = useRef<{ signature: string; commentId: string } | undefined>(undefined);
  const currentSource = artifactId ? "artifact" : preview.ref.source;
  const currentSourceId = artifactId ?? preview.ref.id;
  const comments = review?.refs.filter(ref => ref.annotation?.kind === "image" && ref.annotation.source === currentSource && ref.annotation.sourceId === currentSourceId) ?? [];
  const initialSize = image ? imageCanvasSize(image.naturalWidth, image.naturalHeight) : size;
  const hasLocalEdits = activeDrawings.length > 0 || size.width !== initialSize.width || size.height !== initialSize.height;
  const showImageViewer = compare || mode === "preview" && !hasLocalEdits;

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void imageEditProviders(cwd).then(result => {
      if (!cancelled) { setProviders(result); setProviderId(result[0]?.id ?? ""); }
    }, reason => { if (!cancelled) setProviderError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [cwd]);

  useEffect(() => {
    if (!canvas.current || !image) return;
    try { renderEditedImage(canvas.current, image, [...history.slice(0, cursor), ...(drawing ? [drawing] : [])], size.width, size.height); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [image, history, cursor, drawing, size.width, size.height, setError]);

  function addDrawing(item: ImageDrawing): void {
    try {
      const next = appendImageDrawing(history, cursor, item);
      setDraft(current => ({ ...current, history: next, cursor: next.length }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function pointerDown(event: PointerEvent<HTMLCanvasElement>): void {
    if (busy || !image || mode === "preview" || event.pointerType === "mouse" && event.button !== 0 || gesture.current) return;
    event.stopPropagation();
    const position = imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (mode === "comment") { setDraft(current => ({ ...current, point: position })); return; }
    if (mode === "text") {
      if (text.trim()) addDrawing({ tool: mode, points: [position], color, width: strokeWidth / 1000, text: text.trim() });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: ImageDrawing = { tool: mode, points: [position], color, width: strokeWidth / 1000 };
    gesture.current = { id: event.pointerId, drawing: next };
    setDrawing(next);
  }

  function pointerMove(event: PointerEvent<HTMLCanvasElement>): void {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const position = imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    const stroke = active.drawing.points.length >= 5000 ? active.drawing.points.filter((_, index) => index % 2 === 0) : active.drawing.points;
    const points = active.drawing.tool === "brush" || active.drawing.tool === "eraser"
      ? [...stroke, position] : [active.drawing.points[0]!, position];
    active.drawing = { ...active.drawing, points };
    setDrawing(active.drawing);
  }

  function pointerUp(event: PointerEvent<HTMLCanvasElement>): void {
    if (!gesture.current || gesture.current.id !== event.pointerId) return;
    event.stopPropagation();
    addDrawing(gesture.current.drawing);
    gesture.current = undefined;
    setDrawing(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function changeSize(value: string, field: "width" | "height"): void {
    setDraft(current => ({ ...current, [field]: value, ...(keepRatio ? field === "width"
      ? { height: String(Math.round(Number(value) * size.height / size.width)) }
      : { width: String(Math.round(Number(value) * size.width / size.height)) } : {}) }));
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  }

  async function addComment(): Promise<void> {
    if (!review || !review.isCurrent() || !point || !comment.trim() || !canvas.current) return;
    const id = crypto.randomUUID();
    const signature = JSON.stringify([currentSource, currentSourceId, size, activeDrawings]);
    const attached = attachedSnapshot.current;
    if (review.attachImage && (!attached || attached.signature !== signature || !review.refs.some(ref => ref.annotation?.id === attached.commentId))) {
      await review.attachImage(await canvasImageFile(canvas.current, preview.ref.label));
      if (!alive.current || !review.isCurrent()) return;
      attachedSnapshot.current = { signature, commentId: id };
    }
    if (review.save({ path: preview.ref.displayPath ?? preview.ref.label, source: "composer", annotation: {
      kind: "image", id, source: currentSource, sourceId: currentSourceId, x: point.x, y: point.y, text: comment.trim(),
    } })) {
      setDraft(current => ({ ...current, comment: "", point: undefined }));
      setNotice(t("Comment added to your message."));
    }
  }

  async function modelEdit(mask: boolean): Promise<void> {
    if (!cwd || !providerId || !image) return;
    const source = document.createElement("canvas");
    renderEditedImage(source, image, activeDrawings.filter(item => item.tool !== "eraser"), size.width, size.height);
    let maskUrl: string | undefined;
    if (mask) {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = size.width; maskCanvas.height = size.height;
      const context = maskCanvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.fillStyle = "black"; context.fillRect(0, 0, size.width, size.height);
      for (const item of activeDrawings.filter(item => item.tool === "eraser")) drawImageDrawing(context, item, size.width, size.height, true);
      maskUrl = maskCanvas.toDataURL("image/png");
    }
    const result = await runImageEdit({ cwd, providerPresetId: providerId, imageUrl: source.toDataURL("image/png"), maskUrl,
      prompt: mask ? "Remove the objects in the white mask region and reconstruct the background naturally. Preserve all unmasked content."
        : "Remove the background. Preserve the foreground subject, its details and edges. Return an image with a transparent background." });
    if (alive.current && await replaceImage(result.imageUrl, result.artifactId)) setNotice(t("Image edit completed."));
  }

  return <div className="image-review-editor" data-image-review-editor="true" aria-busy={busy}>
    <div className="image-review-tools" role="toolbar" aria-label={t("Image tools")}>
      {modes.map(item => <Button key={item.id} variant={mode === item.id ? "secondary" : "ghost"} size="sm" aria-pressed={mode === item.id}
        disabled={busy || item.id === "comment" && !review} onClick={() => { setCompare(false); setDraft(current => ({ ...current, mode: item.id })); }}>{t(item.label)}</Button>)}
      {preview.compare ? <Button size="sm" variant="ghost" aria-pressed={compare} disabled={busy} onClick={() => setCompare(current => !current)}>{t("Compare")}</Button> : null}
    </div>
    {error ? <InlineFeedback tone="danger">{t(error)}</InlineFeedback> : null}
    {storageError ? <InlineFeedback tone="danger">{t("Image drawing draft could not be saved on this device.")}</InlineFeedback> : null}
    {notice ? <InlineFeedback tone="info">{notice}</InlineFeedback> : null}
    {image && (initialSize.width !== image.naturalWidth || initialSize.height !== image.naturalHeight) ? <InlineFeedback tone="info">{t("The image is scaled to fit the editing canvas.")}</InlineFeedback> : null}
    {showImageViewer ? <ImageCompareViewer current={{ label: preview.ref.label, imageUrl }} compare={preview.compare} onImageError={artifactId ? undefined : onImageError} /> : null}
    <div className="image-review-stage" hidden={showImageViewer}>
      <div className="image-review-canvas-wrap" style={{ aspectRatio: `${size.width}/${size.height}`, width: `min(100%, calc(60vh * ${size.width / size.height}))` }}>
        <canvas ref={canvas} aria-label={t("Image editing canvas")} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
          onPointerCancel={() => { gesture.current = undefined; setDrawing(undefined); }}
          style={{ touchAction: mode === "preview" ? "auto" : "none", cursor: mode === "preview" ? "default" : "crosshair" }} />
        {mode === "comment" ? comments.map((ref, index) => ref.annotation?.kind === "image" ? <button type="button" className="image-review-pin" key={ref.annotation.id}
          style={{ left: `${ref.annotation.x * 100}%`, top: `${ref.annotation.y * 100}%` }} title={ref.annotation.text} aria-label={ref.annotation.text}
          onClick={() => { const annotation = ref.annotation; if (annotation?.kind === "image") setDraft(current => ({ ...current, point: annotation })); }}>{index + 1}</button> : null) : null}
        {mode === "comment" && point ? <span className="image-review-pin selected" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>+</span> : null}
      </div>
    </div>
    {mode === "comment" ? <div className="image-review-comment-form">
      <p>{t("Click an image position to add feedback.")}{point ? ` (${Math.round(point.x * 100)}%, ${Math.round(point.y * 100)}%)` : ""}</p>
      <Textarea rows={2} maxLength={8000} disabled={busy} aria-label={t("Image comment")} value={comment} onChange={event => setDraft(current => ({ ...current, comment: event.target.value }))} />
      <Button size="sm" disabled={busy || !image || !point || !comment.trim() || (review?.refs.length ?? 12) >= 12} onClick={() => void perform(addComment)}>{t("Add comment")}</Button>
    </div> : null}
    {mode !== "preview" && mode !== "comment" ? <div className="image-review-options">
      <label>{t("Color")}<Select disabled={busy} aria-label={t("Drawing color")} value={color} onChange={event => setDraft(current => ({ ...current, color: event.target.value }))}>
        <option value="#e54d4d">{t("Red")}</option><option value="#30a46c">{t("Green")}</option><option value="#3e63dd">{t("Blue")}</option><option value="#ffffff">{t("White")}</option><option value="#000000">{t("Black")}</option>
      </Select></label>
      <label>{t("Stroke width")}<Input disabled={busy} aria-label={t("Stroke width")} type="number" min={1} max={200} value={strokeWidth} onChange={event => setDraft(current => ({ ...current, strokeWidth: Math.min(200, Math.max(1, Number(event.target.value) || 1)) }))} /></label>
      {mode === "text" ? <Input disabled={busy} aria-label={t("Annotation text")} maxLength={500} value={text} onChange={event => setDraft(current => ({ ...current, text: event.target.value }))} placeholder={t("Annotation text")} /> : null}
      <Button size="sm" variant="ghost" disabled={busy || cursor === 0} onClick={() => setDraft(current => ({ ...current, cursor: current.cursor - 1 }))}>{t("Undo")}</Button>
      <Button size="sm" variant="ghost" disabled={busy || cursor === history.length} onClick={() => setDraft(current => ({ ...current, cursor: current.cursor + 1 }))}>{t("Redo")}</Button>
    </div> : null}
    <div className="image-review-options">
      <Input disabled={busy} aria-label={t("Image width")} type="number" min={1} max={8192} value={width} onChange={event => changeSize(event.target.value, "width")} /><span>×</span>
      <Input disabled={busy} aria-label={t("Image height")} type="number" min={1} max={8192} value={height} onChange={event => changeSize(event.target.value, "height")} />
      <Checkbox disabled={busy} label={t("Keep aspect ratio")} checked={keepRatio} onChange={event => setDraft(current => ({ ...current, keepRatio: event.target.checked }))} />
      <Button size="sm" disabled={busy || !image} onClick={() => {
        try { validateImageSize(Number(width), Number(height)); setDraft(current => ({ ...current, size: { width: Number(width), height: Number(height) } })); setError(""); }
        catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      }}>{t("Resize")}</Button>
    </div>
    <div className="image-review-options">
      <Select aria-label={t("Image editing model")} value={providerId} disabled={busy || !providers.length} onChange={event => setProviderId(event.target.value)}>
        {!providers.length ? <option value="">{t("Configure a live image editing model in Model Workbench.")}</option> : providers.map(provider => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
      </Select>
      <Button size="sm" disabled={busy || !providerId || !image} onClick={() => void perform(() => modelEdit(false))}>{t("Remove background")}</Button>
      <Button size="sm" disabled={busy || !providerId || !image || !activeDrawings.some(item => item.tool === "eraser")} onClick={() => void perform(() => modelEdit(true))}>{t("Repair erased area")}</Button>
    </div>
    {providerError ? <InlineFeedback tone="danger">{providerError}</InlineFeedback> : null}
    <div className="image-review-actions">
      {busy ? <span role="status">{t("Processing image...")}</span> : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(async () => { await replaceImage(preview.imageUrl!); })}>{t("Restore original")}</Button>
      <Button size="sm" disabled={busy || !image} onClick={() => void perform(async () => {
        const file = await canvasImageFile(canvas.current!, preview.ref.label);
        const url = URL.createObjectURL(file); const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>{t("Download edited image")}</Button>
      {review?.attachImage ? <Button size="sm" disabled={busy || !image} onClick={() => void perform(async () => {
        await review.attachImage!(await canvasImageFile(canvas.current!, preview.ref.label));
        if (alive.current && review.isCurrent()) setNotice(t("Image added to your message."));
      })}>{t("Add image to message")}</Button> : null}
    </div>
  </div>;
}
