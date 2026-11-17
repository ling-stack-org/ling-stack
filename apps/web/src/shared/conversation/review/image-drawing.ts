export type ImageDrawingTool = "brush" | "line" | "arrow" | "rectangle" | "ellipse" | "text" | "eraser";
export type ImageEditMode = ImageDrawingTool | "comment" | "preview";
export interface ImagePoint { readonly x: number; readonly y: number; }
export interface ImageDrawing {
  readonly tool: ImageDrawingTool;
  readonly points: readonly ImagePoint[];
  readonly color: string;
  readonly width: number;
  readonly text?: string;
}
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_IMAGE_DRAWINGS = 200;
export interface ImageEditDraft {
  readonly history: readonly ImageDrawing[];
  readonly cursor: number;
  readonly mode: ImageEditMode;
  readonly color: string;
  readonly strokeWidth: number;
  readonly text: string;
  readonly comment: string;
  readonly point?: ImagePoint;
  readonly size?: { readonly width: number; readonly height: number };
  readonly width: string;
  readonly height: string;
  readonly keepRatio: boolean;
  readonly artifactId?: string;
}
export const EMPTY_IMAGE_DRAFT: ImageEditDraft = {
  history: [], cursor: 0, mode: "preview", color: "#e54d4d", strokeWidth: 8,
  text: "", comment: "", width: "", height: "", keepRatio: true,
};
const tools = ["brush", "line", "arrow", "rectangle", "ellipse", "text", "eraser"];
function isImagePoint(point: unknown): point is ImagePoint {
  if (!point || typeof point !== "object") return false;
  const value = point as ImagePoint;
  return Number.isFinite(value.x) && value.x >= 0 && value.x <= 1 && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1;
}
export function parseImageEditDraft(value: unknown): ImageEditDraft {
  try {
    if (!value || typeof value !== "object") return EMPTY_IMAGE_DRAFT;
    const draft = value as ImageEditDraft;
    if (!Array.isArray(draft.history) || draft.history.length > MAX_IMAGE_DRAWINGS || !draft.history.every((drawing: ImageDrawing) =>
      drawing && tools.includes(drawing.tool) && /^#[0-9a-f]{6}$/i.test(drawing.color) && Number.isFinite(drawing.width) && drawing.width >= 0.001 && drawing.width <= 0.2 &&
      (drawing.text === undefined || typeof drawing.text === "string" && drawing.text.length <= 500) && Array.isArray(drawing.points) && drawing.points.length > 0 && drawing.points.length <= 5000 && drawing.points.every(isImagePoint))) return EMPTY_IMAGE_DRAFT;
    if (!Number.isInteger(draft.cursor) || draft.cursor < 0 || draft.cursor > draft.history.length || ![...tools, "comment", "preview"].includes(draft.mode) ||
      !/^#[0-9a-f]{6}$/i.test(draft.color) || !Number.isFinite(draft.strokeWidth) || draft.strokeWidth < 1 || draft.strokeWidth > 200 ||
      typeof draft.text !== "string" || draft.text.length > 500 || typeof draft.comment !== "string" || draft.comment.length > 8000 ||
      draft.point !== undefined && !isImagePoint(draft.point) || typeof draft.width !== "string" || draft.width.length > 8 || typeof draft.height !== "string" || draft.height.length > 8 ||
      typeof draft.keepRatio !== "boolean" || draft.artifactId !== undefined && (typeof draft.artifactId !== "string" || !/^[\w-]{1,500}$/.test(draft.artifactId))) return EMPTY_IMAGE_DRAFT;
    if (draft.size) validateImageSize(draft.size.width, draft.size.height);
    return draft;
  } catch { return EMPTY_IMAGE_DRAFT; }
}
export function validateImageSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) throw new Error("Image dimensions must be 1–8192 pixels and at most 16 megapixels.");
}
export function imageCanvasSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 8192 / width, 8192 / height, Math.sqrt(MAX_IMAGE_PIXELS / (width * height)));
  const size = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  validateImageSize(size.width, size.height);
  return size;
}
export function imagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): ImagePoint {
  return { x: Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))), y: Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height))) };
}
export function appendImageDrawing(history: readonly ImageDrawing[], cursor: number, drawing: ImageDrawing): readonly ImageDrawing[] {
  const retained = history.slice(0, cursor);
  if (retained.length >= MAX_IMAGE_DRAWINGS) throw new Error("The image has reached the 200 drawing limit. Undo a drawing or export the image before adding more.");
  return [...retained, drawing];
}
export function drawImageDrawing(context: CanvasRenderingContext2D, drawing: ImageDrawing, width: number, height: number, mask = false): void {
  const first = drawing.points[0]; const last = drawing.points.at(-1);
  if (!first || !last) return;
  const x = first.x * width; const y = first.y * height; const endX = last.x * width; const endY = last.y * height;
  context.save(); context.strokeStyle = mask ? "white" : drawing.color; context.fillStyle = context.strokeStyle;
  context.lineWidth = drawing.width * Math.min(width, height); context.lineCap = "round"; context.lineJoin = "round";
  if (drawing.tool === "eraser" && !mask) context.globalCompositeOperation = "destination-out";
  context.beginPath();
  if (drawing.tool === "text") { context.font = `${Math.max(12, context.lineWidth * 5)}px sans-serif`; context.fillText(drawing.text ?? "", x, y); }
  else if (drawing.tool === "rectangle") { context.strokeRect(x, y, endX - x, endY - y); }
  else if (drawing.tool === "ellipse") { context.ellipse((x + endX) / 2, (y + endY) / 2, Math.abs(endX - x) / 2, Math.abs(endY - y) / 2, 0, 0, Math.PI * 2); context.stroke(); }
  else {
    context.moveTo(x, y);
    if (drawing.tool === "brush" || drawing.tool === "eraser") {
      for (const point of drawing.points.slice(1)) context.lineTo(point.x * width, point.y * height);
      if (drawing.points.length === 1) context.lineTo(x + 0.01, y + 0.01);
    } else context.lineTo(endX, endY);
    context.stroke();
    if (drawing.tool === "arrow") {
      const angle = Math.atan2(endY - y, endX - x); const size = context.lineWidth * 4;
      context.beginPath(); context.moveTo(endX - size * Math.cos(angle - Math.PI / 6), endY - size * Math.sin(angle - Math.PI / 6));
      context.lineTo(endX, endY); context.lineTo(endX - size * Math.cos(angle + Math.PI / 6), endY - size * Math.sin(angle + Math.PI / 6)); context.stroke();
    }
  }
  context.restore();
}
export function renderEditedImage(canvas: HTMLCanvasElement, image: CanvasImageSource, drawings: readonly ImageDrawing[], width: number, height: number): void {
  validateImageSize(width, height); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas is unavailable.");
  context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height);
  for (const drawing of drawings) drawImageDrawing(context, drawing, width, height);
}
export async function canvasImageFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("Image export failed.")), "image/png"));
  return new File([blob], name.replace(/\.[^.]+$/, "") + "-edited.png", { type: "image/png" });
}
