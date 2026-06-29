import type { DockPageKind, DockPageStackEntry } from "./dock-types.js";

export function createDockPageEntry(input: {
  readonly page: DockPageKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly sourceId?: string;
  readonly parentId?: string;
}): DockPageStackEntry {
  const sourcePart = input.sourceId ? `:${input.sourceId}` : "";
  return {
    id: `${input.page}:${input.title}${sourcePart}`,
    page: input.page,
    title: input.title,
    subtitle: input.subtitle,
    sourceId: input.sourceId,
    parentId: input.parentId,
  };
}

export function pushDockPage(
  stack: readonly DockPageStackEntry[],
  entry: DockPageStackEntry,
): readonly DockPageStackEntry[] {
  const parentId = stack.length > 0 ? stack[stack.length - 1]?.id : undefined;
  return [...stack, parentId && !entry.parentId ? { ...entry, parentId } : entry];
}

export function popDockPage(
  stack: readonly DockPageStackEntry[],
): readonly DockPageStackEntry[] {
  return stack.length > 0 ? stack.slice(0, -1) : stack;
}

export function resetDockStack(): readonly DockPageStackEntry[] {
  return [];
}

export function activeDockPage(
  stack: readonly DockPageStackEntry[],
): DockPageStackEntry | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}
