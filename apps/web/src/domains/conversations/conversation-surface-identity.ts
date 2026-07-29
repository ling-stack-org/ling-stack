export function createConversationDraftIdentity(generation: number): string {
  return `draft:${Math.max(0, Math.trunc(generation))}`;
}

export function isConversationDraftIdentity(identity: string): boolean {
  return /^draft:\d+$/u.test(identity);
}

export function readConversationDraftGeneration(identity: string): number | undefined {
  if (!isConversationDraftIdentity(identity)) return undefined;
  return Number.parseInt(identity.slice("draft:".length), 10);
}
