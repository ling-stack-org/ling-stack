export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine || "Untitled task";
}
