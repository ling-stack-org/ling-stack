export function downloadMemoryMarkdown(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
