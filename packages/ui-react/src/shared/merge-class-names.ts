export function mergeClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
