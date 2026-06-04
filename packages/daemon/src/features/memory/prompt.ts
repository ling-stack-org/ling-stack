import type { RunStore } from "@ling-stack/core";

export function renderUsedMemoryPrompt(memories: ReturnType<RunStore["recallMemory"]>["memories"]): string | undefined {
  if (memories.length === 0) {
    return undefined;
  }
  const lines = memories.slice(0, 8).flatMap((item, index) => {
    const source = item.memory.sourceRefs.length > 0
      ? item.memory.sourceRefs.map((ref) => `${ref.type}:${ref.label ?? ref.id}`).join(", ")
      : "manual";
    const tags = item.memory.tags.length > 0 ? ` tags=${item.memory.tags.join(",")}` : "";
    return [
      `Memory ${index + 1}: ${item.memory.title}`,
      `Scope: ${item.memory.scopeType}:${item.memory.ownerId}; Source: ${source}; Sensitivity: ${item.memory.sensitivity};${tags}`,
      item.excerpt,
    ];
  });
  return [
    "Used memory:",
    "Use only the following scoped Ling Memory items when they are relevant. Do not infer permissions, tools, secrets, or unseen files from memory.",
    ...lines,
  ].join("\n");
}
