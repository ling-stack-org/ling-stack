import type { WebContents } from "electron";
import {
  builtInDesktopRendererThemeInput,
  parseDesktopRendererThemeInput,
  type DesktopRendererThemeInput,
  type DesktopRendererThemeSnapshot,
} from "../shared/renderer-theme.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";

type ThemeRendererTarget = Pick<WebContents, "id" | "isDestroyed" | "send"> &
  Partial<Pick<WebContents, "once">>;

export class DesktopRendererThemeStore {
  private revision = 1;
  private snapshot: DesktopRendererThemeSnapshot;
  private readonly renderers = new Map<number, ThemeRendererTarget>();

  constructor(initial: DesktopRendererThemeInput = builtInDesktopRendererThemeInput("light")) {
    const parsed = parseDesktopRendererThemeInput(initial) ?? builtInDesktopRendererThemeInput("light");
    this.snapshot = Object.freeze({ ...parsed, revision: this.revision });
  }

  getSnapshot(): DesktopRendererThemeSnapshot {
    return this.snapshot;
  }

  report(value: unknown): DesktopRendererThemeSnapshot | undefined {
    const input = parseDesktopRendererThemeInput(value);
    if (!input) {
      return undefined;
    }
    if (themeInputEquals(this.snapshot, input)) {
      return this.snapshot;
    }
    this.revision += 1;
    this.snapshot = Object.freeze({ ...input, revision: this.revision });
    this.broadcast();
    return this.snapshot;
  }

  trackRenderer(renderer: ThemeRendererTarget): void {
    if (renderer.isDestroyed()) {
      return;
    }
    if (this.renderers.has(renderer.id)) {
      return;
    }
    this.renderers.set(renderer.id, renderer);
    renderer.once?.("destroyed", () => this.renderers.delete(renderer.id));
  }

  dispose(): void {
    this.renderers.clear();
  }

  private broadcast(): void {
    for (const [id, renderer] of this.renderers) {
      if (renderer.isDestroyed()) {
        this.renderers.delete(id);
        continue;
      }
      try {
        renderer.send(DESKTOP_IPC_CHANNELS.desktopThemeSnapshotChanged, this.snapshot);
      } catch {
        this.renderers.delete(id);
      }
    }
  }
}

function themeInputEquals(
  current: DesktopRendererThemeInput,
  next: DesktopRendererThemeInput,
): boolean {
  if (
    current.themeId !== next.themeId
    || current.colorScheme !== next.colorScheme
    || current.presentationProfileId !== next.presentationProfileId
  ) {
    return false;
  }
  const currentEntries = Object.entries(current.variables);
  const nextEntries = Object.entries(next.variables);
  return currentEntries.length === nextEntries.length
    && currentEntries.every(([key, value]) => next.variables[key as keyof typeof next.variables] === value);
}
