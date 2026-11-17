import type { DesktopBrowserAnnotation } from "../../../../desktop/shared/browser-annotations.js";

export interface BrowserAnnotationSubmission { readonly comment: string; readonly files: readonly File[] }
export type BrowserAnnotationHandler = (submission: BrowserAnnotationSubmission) => Promise<void>;

export function browserAnnotationSubmission(annotation: DesktopBrowserAnnotation, comment: string, includeScreenshot: boolean): BrowserAnnotationSubmission {
  const { screenshot, ...metadata } = annotation;
  const files = [new File([JSON.stringify({ ...metadata, trust: "untrusted_web_content" }, null, 2)], `browser-annotation-${annotation.id}.json`, { type: "application/json" })];
  if (includeScreenshot && screenshot) {
    const bytes = Uint8Array.from(atob(screenshot.data), character => character.charCodeAt(0));
    files.push(new File([bytes], `browser-annotation-${annotation.id}.jpg`, { type: screenshot.mimeType }));
  }
  return { comment: comment.trim(), files };
}
