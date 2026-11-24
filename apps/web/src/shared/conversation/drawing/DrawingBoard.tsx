import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Check, Circle, Eraser, MousePointer2, Paintbrush, Pencil, Redo2, Square, Type, Undo2, X } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { Dialog, DialogContent, Input } from "../../ui/index.js";
import { drawImageDrawing, imagePoint, type ImageDrawing, type ImagePoint } from "../review/image-drawing.js";
import "./drawing-board.css";

type Tool = "select" | "brush" | "text" | "rectangle" | "ellipse" | "eraser";
const colors = ["#ffffff", "#a4a7b0", "#3b82f6", "#18bc91", "#ffbd2e", "#ff526b", "#a855f7"];
const width = 960, height = 960;
const limit = 200;

export function DrawingBoardEntry({ onAttach, disabled = false, identity }: { readonly onAttach: (file: File) => void | Promise<void>; readonly disabled?: boolean; readonly identity?: string }): React.JSX.Element {
  const { t } = useI18n();
  const [opened, setOpened] = useState<{ identity: string | undefined }>();
  useEffect(() => { setOpened(undefined); }, [identity]);
  return <>
    <button type="button" className="icon-button composer-tool-button" aria-label={t("Drawing board")} title={t("Drawing board")} disabled={disabled} onClick={() => setOpened({ identity })}><Pencil size={17} /></button>
    {opened && opened.identity === identity ? <DrawingBoard onClose={() => setOpened(undefined)} onAttach={onAttach} /> : null}
  </>;
}

function DrawingBoard({ onClose, onAttach }: { readonly onClose: () => void; readonly onAttach: (file: File) => void | Promise<void> }): React.JSX.Element {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [shape, setShape] = useState<"rectangle" | "ellipse">("rectangle");
  const [color, setColor] = useState(colors[0]!);
  const [stroke, setStroke] = useState(6);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<readonly (readonly ImageDrawing[])[]>([[]]);
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<readonly ImageDrawing[]>();
  const draftRef = useRef<readonly ImageDrawing[] | undefined>(undefined);
  const [selected, setSelected] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drag = useRef<{ id: number; start: ImagePoint; index?: number; base: readonly ImageDrawing[]; item?: ImageDrawing } | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = draft ?? history[cursor]!;
  function updateDraft(value: readonly ImageDrawing[] | undefined): void { draftRef.current = value; setDraft(value); }
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d"); if (!ctx) return;
    ctx.fillStyle = "#19191c"; ctx.fillRect(0, 0, width, height);
    for (const item of current) drawImageDrawing(ctx, item, width, height);
  }, [current]);
  function commit(next: readonly ImageDrawing[]): void {
    setHistory(previous => [...previous.slice(Math.max(0, cursor - 99), cursor + 1), next]);
    setCursor(value => Math.min(100, value + 1)); updateDraft(undefined);
  }
  function hit(point: ImagePoint): number | undefined {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return undefined;
    const displayWidth = canvas.current!.getBoundingClientRect().width;
    for (let i = current.length - 1; i >= 0; i--) {
      const item = current[i]!; const first = item.points[0]!, last = item.points.at(-1)!;
      const x = point.x * width, y = point.y * height;
      const x1 = first.x * width, y1 = first.y * height, x2 = last.x * width, y2 = last.y * height;
      const tolerance = 8 * width / Math.max(1, displayWidth);
      ctx.save();
      ctx.lineWidth = item.width * width + 2 * tolerance; ctx.lineCap = "round"; ctx.lineJoin = "round";
      let matched = false;
      if (item.tool === "text") {
        const fontSize = Math.max(12, item.width * width * 5);
        ctx.font = `${fontSize}px sans-serif`;
        const metrics = ctx.measureText(item.text ?? "");
        matched = x >= x1 - tolerance && x <= x1 + metrics.width + tolerance && y >= y1 - fontSize - tolerance && y <= y1 + tolerance;
      } else {
        ctx.beginPath();
        if (item.tool === "rectangle") ctx.rect(x1, y1, x2 - x1, y2 - y1);
        else if (item.tool === "ellipse" && x1 !== x2 && y1 !== y2) ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        else {
          ctx.moveTo(x1, y1);
          for (const p of item.points.slice(1)) ctx.lineTo(p.x * width, p.y * height);
          if (item.points.length === 1) ctx.lineTo(x1 + 0.01, y1 + 0.01);
        }
        matched = ctx.isPointInStroke(x, y);
      }
      ctx.restore();
      if (matched) return i;
    }
    return undefined;
  }
  function down(event: PointerEvent<HTMLCanvasElement>): void {
    if (busy || event.button !== 0) return;
    const point = imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (tool === "select" || tool === "eraser") {
      const index = hit(point); setSelected(index);
      if (index === undefined) return;
      if (tool === "eraser") { commit(current.filter((_, i) => i !== index)); setSelected(undefined); return; }
      drag.current = { id: event.pointerId, start: point, index, base: current };
    } else {
      if (current.length >= limit) { setError(t("The image has reached the 200 drawing limit. Undo a drawing or export the image before adding more.")); return; }
      if (tool === "text" && !text.trim()) return;
      setError("");
      const item: ImageDrawing = { tool, points: [point], color, width: stroke / 1000, ...(tool === "text" ? { text: text.trim() } : {}) };
      if (tool === "text") { commit([...current, item]); setText(""); return; }
      drag.current = { id: event.pointerId, start: point, base: current, item };
      updateDraft([...current, item]);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLCanvasElement>): void {
    const active = drag.current; if (!active || active.id !== event.pointerId) return;
    const point = imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (active.index !== undefined) {
      const item = active.base[active.index]!; const dx = point.x - active.start.x, dy = point.y - active.start.y;
      const xs = item.points.map(p => p.x), ys = item.points.map(p => p.y);
      const safeX = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx));
      const safeY = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
      updateDraft(active.base.map((entry, index) => index === active.index ? { ...entry, points: entry.points.map(p => ({ x: p.x + safeX, y: p.y + safeY })) } : entry));
    } else if (active.item) {
      if (active.item.tool === "brush" && active.item.points.length >= 5000) return;
      const points = active.item.tool === "brush" ? [...active.item.points, point] : [active.start, point];
      active.item = { ...active.item, points }; updateDraft([...active.base, active.item]);
    }
  }
  function up(event: PointerEvent<HTMLCanvasElement>): void {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    if (draftRef.current) commit(draftRef.current); drag.current = undefined; updateDraft(undefined);
  }
  async function finish(): Promise<void> {
    if (!canvas.current || !current.length || busy) return;
    setBusy(true); setError("");
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.current!.toBlob(value => value ? resolve(value) : reject(new Error("Image export failed.")), "image/png"));
      if (!alive.current) return;
      await onAttach(new File([blob], `drawing-${Date.now()}.png`, { type: "image/png" })); if (alive.current) onClose();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(false); }
  }
  const tools: readonly { id: Tool; label: string; Icon: typeof Pencil }[] = [
    { id: "select", label: "Select", Icon: MousePointer2 }, { id: "brush", label: "Brush", Icon: Paintbrush },
    { id: "text", label: "Text", Icon: Type }, { id: shape, label: shape === "rectangle" ? "Rectangle" : "Ellipse", Icon: shape === "rectangle" ? Square : Circle },
    { id: "eraser", label: "Erase drawing", Icon: Eraser },
  ];
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent className="drawing-board" overlayClassName="drawing-board-overlay" aria-label={t("Drawing board")} aria-labelledby={undefined} aria-describedby={undefined} onPointerDownOutside={event => event.preventDefault()}>
      <div className="drawing-board-header">
        <button type="button" aria-label={t("Cancel")} title={t("Cancel")} onClick={onClose} disabled={busy}><X size={20} /></button>
        <div className="drawing-board-toolbar" role="toolbar" aria-label={t("Drawing board")}>
          {tools.map(({ id, label, Icon }) => <button type="button" key={label} aria-label={t(label)} title={t(label)} aria-pressed={tool === id} onClick={() => { setTool(id); setSelected(undefined); }}><Icon size={19} /></button>)}
          <button type="button" aria-label={t("Change shape")} title={t("Change shape")} onClick={() => { const next = shape === "rectangle" ? "ellipse" : "rectangle"; setShape(next); setTool(next); }}>⌄</button>
        </div>
        <div className="drawing-board-history"><button type="button" aria-label={t("Undo")} title={t("Undo")} disabled={busy || cursor === 0} onClick={() => { setCursor(n => n - 1); setSelected(undefined); }}><Undo2 size={19} /></button><button type="button" aria-label={t("Redo")} title={t("Redo")} disabled={busy || cursor === history.length - 1} onClick={() => { setCursor(n => n + 1); setSelected(undefined); }}><Redo2 size={19} /></button></div>
      </div>
      {tool === "text" ? <Input containerClassName="drawing-board-text" aria-label={t("Annotation text")} placeholder={t("Annotation text")} maxLength={500} value={text} onChange={event => setText(event.target.value)} /> : null}
      <div className="drawing-board-stage"><canvas ref={canvas} width={width} height={height} aria-label={t("Drawing canvas")} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = undefined; updateDraft(undefined); }} />
        <label className="drawing-board-stroke"><span className="drawing-board-sr">{t("Stroke width")}</span><input data-ling-control-native="true" type="range" aria-label={t("Stroke width")} min="1" max="30" value={stroke} onChange={event => setStroke(Number(event.target.value))} /></label>
        {tool === "select" && selected !== undefined ? <span className="drawing-board-selection" role="status">{t("Drag to move")}</span> : null}
      </div>
      {error ? <div role="alert" className="drawing-board-error">{error}</div> : null}
      <div className="drawing-board-footer"><label className="drawing-board-color-picker" title={t("Color")}><Input type="color" aria-label={t("Color")} value={color} onChange={event => setColor(event.target.value)} /></label><div className="drawing-board-colors">{colors.map(value => <button key={value} type="button" aria-label={`${t("Color")} ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} style={{ background: value }} />)}</div><button type="button" className="drawing-board-done" aria-label={t("Add image to message")} title={t("Add image to message")} disabled={busy || current.length === 0} onClick={() => void finish()}><Check size={22} /></button></div>
    </DialogContent>
  </Dialog>;
}
