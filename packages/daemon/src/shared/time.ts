export function formatTimestampSlug(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "") || "now";
}
