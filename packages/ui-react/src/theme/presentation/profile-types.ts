import type {
  LingPresentationProfileId,
  LingThemeArtworkSlot,
} from "../types.js";

export type LingThemeDecorationSet = "none" | "home-corners";

export type LingPresentationSurface =
  | "home"
  | "sidebar"
  | "conversation"
  | "channel"
  | "settings"
  | "management"
  | "media-canvas"
  | "overlay"
  | "diagnostics"
  | "approvals";

export type LingPresentationSurfaceRecipe = "solid" | "frosted" | "translucent" | "domain";
export type LingPresentationArtworkLevel = "off" | "optional" | "ambient" | "strong";

export interface LingPresentationSurfacePolicy {
  readonly surfaceRecipe: LingPresentationSurfaceRecipe;
  readonly artwork: LingPresentationArtworkLevel;
  readonly decorations: boolean;
}

export interface LingPresentationRoutePolicy {
  readonly home: LingPresentationSurfacePolicy;
  readonly sidebar: LingPresentationSurfacePolicy;
  readonly conversation: LingPresentationSurfacePolicy;
  readonly channel: LingPresentationSurfacePolicy;
  readonly settings: LingPresentationSurfacePolicy;
  readonly management: LingPresentationSurfacePolicy;
  readonly "media-canvas": LingPresentationSurfacePolicy;
  readonly overlay: LingPresentationSurfacePolicy;
  readonly diagnostics: LingPresentationSurfacePolicy;
  readonly approvals: LingPresentationSurfacePolicy;
}

export interface LingPresentationProfileDefinition {
  readonly id: LingPresentationProfileId;
  readonly supportedArtworkSlots: readonly LingThemeArtworkSlot[];
  readonly supportedDecorationSets: readonly LingThemeDecorationSet[];
  readonly routePolicy: LingPresentationRoutePolicy;
  readonly fallbackProfileId: "ling-standard";
}

export interface LingPresentationSurfaceContext {
  readonly viewportWidth?: number;
  readonly reducedTransparency?: boolean;
  readonly forcedColors?: boolean;
}
