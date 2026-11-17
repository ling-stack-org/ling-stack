import type { BrowserAnnotationAnchor } from "../../shared/browser-annotations.js";

type Request = { readonly action: "select"; readonly kind: "element" | "region" } | { readonly action: "cancel" } | { readonly action: "pointer"; readonly phase: "down" | "move" | "up"; readonly x: number; readonly y: number } | { readonly action: "locate"; readonly anchor: BrowserAnnotationAnchor };
/** Selection runs in an isolated world; native input is consumed before it reaches page handlers. */
function annotationProgram(request: Request): Promise<BrowserAnnotationAnchor | null> | boolean {
  const root = globalThis as typeof globalThis & { __lingAnnotation?: { documentId: string; revision: number; observer: MutationObserver; cancel?: () => void; pointer?: (input: { phase: "down" | "move" | "up"; x: number; y: number }) => void } };
  if (!root.__lingAnnotation) {
    const changed = (records: MutationRecord[]): boolean => records.some(record => {
      if (record.target instanceof Element && record.target.closest("[data-ling-annotation]")) return false;
      return record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element && node.hasAttribute("data-ling-annotation")));
    });
    const state = { documentId: crypto.randomUUID(), revision: 0, observer: new MutationObserver(records => { if (changed(records)) state.revision++; }) };
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); root.__lingAnnotation = state;
  }
  const state = root.__lingAnnotation;
  if (state.observer.takeRecords().some(record => !(record.target instanceof Element && record.target.closest("[data-ling-annotation]"))
    && (record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element && node.hasAttribute("data-ling-annotation")))))) state.revision++;
  const signature = (node: Element): string => JSON.stringify([node.tagName, node.id, node.getAttribute("role"), node.getAttribute("aria-label"), node.getAttribute("type"), (node.textContent ?? "").replace(/\s+/gu, " ").slice(0, 500)]);
  if (request.action === "pointer") { state.pointer?.(request); return true; }
  state.cancel?.();
  if (request.action === "cancel") return true;
  if (request.action === "locate") {
    const a = request.anchor;
    if (a.documentId !== state.documentId) return false;
    let rect = a.rect;
    if (a.kind === "region") {
      if (a.documentRevision !== state.revision || a.viewport.scrollX !== scrollX || a.viewport.scrollY !== scrollY || a.viewport.width !== innerWidth || a.viewport.height !== innerHeight || a.viewport.zoom !== devicePixelRatio) return false;
    } else {
      const node = document.querySelector(a.selector);
      if (!node || signature(node) !== a.signature) return false;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return false;
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    const marker = document.createElement("div"); marker.setAttribute("data-ling-annotation", "highlight");
    Object.assign(marker.style, { position: "fixed", zIndex: "2147483647", pointerEvents: "none", border: "3px solid #548aff", boxSizing: "border-box", left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.documentElement.append(marker); setTimeout(() => marker.remove(), 1800); return true;
  }
  return new Promise(resolve => {
    const overlay = document.createElement("div"); overlay.setAttribute("data-ling-annotation", "selection");
    Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair", background: "transparent" });
    const shadow = overlay.attachShadow({ mode: "closed" });
    const outline = document.createElement("div"); Object.assign(outline.style, { position: "fixed", pointerEvents: "none", border: "2px solid #548aff", background: "#548aff22", boxSizing: "border-box" }); shadow.append(outline);
    let start: { x: number; y: number } | undefined, node: Element | null = null, box: { x: number; y: number; width: number; height: number } | undefined;
    const finish = (value: BrowserAnnotationAnchor | null): void => {
      clearTimeout(timer); removeEventListener("pagehide", cancel); overlay.remove(); state.cancel = undefined; state.pointer = undefined; resolve(value);
    };
    const cancel = (): void => finish(null);
    const update = (event: { clientX: number; clientY: number }): void => {
      if (request.kind === "region") {
        if (!start) return;
        box = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) };
      } else {
        overlay.style.pointerEvents = "none"; node = document.elementFromPoint(event.clientX, event.clientY); overlay.style.pointerEvents = "auto";
        if (!node || node.closest("input,textarea,[contenteditable],iframe")) { box = undefined; return; }
        const r = node.getBoundingClientRect(); box = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(innerWidth, r.right) - Math.max(0, r.x), height: Math.min(innerHeight, r.bottom) - Math.max(0, r.y) };
      }
      if (box) Object.assign(outline.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    };
    const up = (event: { clientX: number; clientY: number }): void => {
      update(event);
      if (!box || box.width < 2 || box.height < 2 || request.kind === "region" && !start) return;
      const path: string[] = [];
      if (request.kind === "element" && node) {
        let current: Element | null = node;
        while (current && path.length < 30) { const element: Element = current; const index = element.parentElement ? [...element.parentElement.children].indexOf(element) + 1 : 1;
          path.unshift(`${element.tagName.toLowerCase()}:nth-child(${index})`); current = element.parentElement; }
        if (current) { finish(null); return; }
      }
      const value: BrowserAnnotationAnchor = { kind: request.kind, documentId: state.documentId, documentRevision: state.revision, selector: path.join(" > "), signature: node && request.kind === "element" ? signature(node) : "",
        excerpt: node && request.kind === "element" ? (node.textContent ?? "").replace(/\s+/gu, " ").slice(0, 2000) : "", rect: box,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, zoom: devicePixelRatio } };
      finish(value);
    };
    state.pointer = input => {
      const event = { clientX: Math.max(0, Math.min(innerWidth - 1, input.x)), clientY: Math.max(0, Math.min(innerHeight - 1, input.y)) };
      if (input.phase === "down") { start = { x: event.clientX, y: event.clientY }; update(event); }
      else if (input.phase === "move") update(event);
      else up(event);
    };
    const timer = setTimeout(cancel, 60_000); state.cancel = cancel;
    addEventListener("pagehide", cancel, { once: true }); document.documentElement.append(overlay);
  });
}
export function browserAnnotationScript(request: Request): string { return `(${annotationProgram.toString()})(${JSON.stringify(request)})`; }
