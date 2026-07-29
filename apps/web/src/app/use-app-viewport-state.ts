import { useSyncExternalStore } from "react";

export type AppViewportSize = "minimum" | "compact" | "standard" | "large";
export type AppClientSurface = "desktop" | "web";

export interface AppViewportState {
  readonly client: AppClientSurface;
  readonly height: number;
  readonly narrow: boolean;
  readonly size: AppViewportSize;
  readonly width: number;
}

const fallbackSnapshot = "1440:960:web";
const narrowViewportQuery = "(max-width: 900px)";

export function resolveAppViewportSize(width: number, height: number): AppViewportSize {
  if (width <= 1024 || height <= 720) return "minimum";
  if (width <= 1280 || height <= 800) return "compact";
  if (width <= 1920 || height <= 1200) return "standard";
  return "large";
}

export function useAppViewportState(): AppViewportState {
  const snapshot = useSyncExternalStore(subscribeToViewport, readViewportSnapshot, () => fallbackSnapshot);
  const [widthValue, heightValue, clientValue] = snapshot.split(":");
  const width = Number(widthValue) || 1440;
  const height = Number(heightValue) || 960;
  return {
    client: clientValue === "desktop" ? "desktop" : "web",
    height,
    narrow: width <= 900,
    size: resolveAppViewportSize(width, height),
    width,
  };
}

export function useAppNarrowViewport(): boolean {
  return useSyncExternalStore(subscribeToNarrowViewport, readNarrowViewport, () => false);
}

function subscribeToViewport(onStoreChange: () => void): () => void {
  globalThis.addEventListener?.("resize", onStoreChange);
  return () => globalThis.removeEventListener?.("resize", onStoreChange);
}

function readViewportSnapshot(): string {
  if (typeof window === "undefined") return fallbackSnapshot;
  return `${window.innerWidth}:${window.innerHeight}:${window.lingDesktop ? "desktop" : "web"}`;
}

function subscribeToNarrowViewport(onStoreChange: () => void): () => void {
  if (typeof globalThis.matchMedia !== "function") return () => undefined;
  const query = globalThis.matchMedia(narrowViewportQuery);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function readNarrowViewport(): boolean {
  return typeof globalThis.matchMedia === "function"
    ? globalThis.matchMedia(narrowViewportQuery).matches
    : false;
}
