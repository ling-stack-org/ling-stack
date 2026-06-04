import { redactSecrets } from "@ling-stack/core";

export function redactTextWithSecrets(content: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const redacted = redactSecrets(content, extraSecrets);
  return typeof redacted === "string" ? redacted : content;
}
