import { browserInteger, browserRecord, browserString, parseDesktopBrowserScope, parseDesktopBrowserUrl, type DesktopBrowserScope } from "@ling-stack/contracts";

export interface BrowserAnnotationAnchor {
  readonly kind: "element" | "region";
  readonly documentId: string;
  readonly documentRevision: number;
  readonly selector: string;
  readonly signature: string;
  readonly excerpt: string;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number; readonly scrollX: number; readonly scrollY: number; readonly zoom: number };
}
export interface DesktopBrowserAnnotation {
  readonly version: 1;
  readonly id: string;
  readonly workspaceCwd: string;
  readonly scope: DesktopBrowserScope;
  readonly generation: number;
  readonly tabId: string;
  readonly navigationRevision: number;
  readonly url: string;
  readonly origin: string;
  readonly anchor: BrowserAnnotationAnchor;
  readonly screenshot?: { readonly mimeType: "image/jpeg"; readonly data: string };
}
export function parseBrowserAnnotationAnchor(value: unknown): BrowserAnnotationAnchor {
  const r = browserRecord(value, ["kind", "documentId", "documentRevision", "selector", "signature", "excerpt", "rect", "viewport"]);
  if (r.kind !== "element" && r.kind !== "region") throw new Error("browser_annotation_invalid");
  const rect = browserRecord(r.rect, ["x", "y", "width", "height"]), viewport = browserRecord(r.viewport, ["width", "height", "scrollX", "scrollY", "zoom"]);
  const n = (v: unknown, min = 0): number => { if (typeof v !== "number" || !Number.isFinite(v) || v < min || Math.abs(v) > 10_000_000) throw new Error("browser_annotation_invalid"); return v; };
  return { kind: r.kind, documentId: browserString(r.documentId, 128), documentRevision: browserInteger(r.documentRevision), selector: browserString(r.selector, 4096, true), signature: browserString(r.signature, 2048, true),
    excerpt: browserString(r.excerpt, 2000, true), rect: { x: n(rect.x), y: n(rect.y), width: n(rect.width, 1), height: n(rect.height, 1) },
    viewport: { width: n(viewport.width, 1), height: n(viewport.height, 1), scrollX: n(viewport.scrollX, -10_000_000), scrollY: n(viewport.scrollY, -10_000_000), zoom: n(viewport.zoom, 0.01) } };
}
export function parseBrowserAnnotation(value: unknown): DesktopBrowserAnnotation {
  const r = browserRecord(value, ["version", "id", "workspaceCwd", "scope", "generation", "tabId", "navigationRevision", "url", "origin", "anchor"]);
  const url = parseDesktopBrowserUrl(r.url);
  if (r.version !== 1 || r.origin !== new URL(url).origin) throw new Error("browser_annotation_invalid");
  return { version: 1, id: browserString(r.id, 128), workspaceCwd: browserString(r.workspaceCwd, 4096), scope: parseDesktopBrowserScope(r.scope),
    generation: browserInteger(r.generation, 1), tabId: browserString(r.tabId, 128), navigationRevision: browserInteger(r.navigationRevision), url, origin: new URL(url).origin,
    anchor: parseBrowserAnnotationAnchor(r.anchor) };
}
