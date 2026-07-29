import type {
  LingPresentationProfileDefinition,
  LingPresentationRoutePolicy,
  LingPresentationSurfacePolicy,
} from "./profile-types.js";

const solidOff = policy("solid", "off");
const domainOff = policy("domain", "off");

const protectedRoutes = {
  settings: solidOff,
  management: solidOff,
  "media-canvas": domainOff,
  overlay: solidOff,
  diagnostics: solidOff,
  approvals: solidOff,
} as const;

export const builtInPresentationProfiles: readonly LingPresentationProfileDefinition[] = Object.freeze([
  profile("ling-standard", ["home-hero"], ["none"], routes({
    home: policy("solid", "optional"),
    sidebar: solidOff,
    conversation: solidOff,
    channel: solidOff,
  })),
  profile("ling-glass", ["shell-background", "home-hero"], ["none"], routes({
    home: policy("frosted", "strong"),
    sidebar: policy("frosted", "ambient"),
    conversation: policy("translucent", "ambient"),
    channel: policy("translucent", "ambient"),
  })),
  profile("ling-immersive", ["shell-background", "home-hero"], ["none"], routes({
    home: policy("translucent", "strong"),
    sidebar: policy("frosted", "ambient"),
    conversation: policy("translucent", "ambient"),
    channel: policy("translucent", "ambient"),
  })),
  profile("ling-illustrated", [
    "shell-background",
    "home-hero",
    "home-corner-start",
    "home-corner-end",
  ], ["none", "home-corners"], routes({
    home: policy("translucent", "strong", true),
    sidebar: policy("frosted", "ambient"),
    conversation: policy("translucent", "ambient"),
    channel: policy("translucent", "ambient"),
  })),
]);

function profile(
  id: LingPresentationProfileDefinition["id"],
  supportedArtworkSlots: LingPresentationProfileDefinition["supportedArtworkSlots"],
  supportedDecorationSets: LingPresentationProfileDefinition["supportedDecorationSets"],
  routePolicy: LingPresentationRoutePolicy,
): LingPresentationProfileDefinition {
  return Object.freeze({
    id,
    supportedArtworkSlots: Object.freeze([...supportedArtworkSlots]),
    supportedDecorationSets: Object.freeze([...supportedDecorationSets]),
    routePolicy: Object.freeze(routePolicy),
    fallbackProfileId: "ling-standard",
  });
}

function routes(
  visible: Pick<LingPresentationRoutePolicy, "home" | "sidebar" | "conversation" | "channel">,
): LingPresentationRoutePolicy {
  return { ...visible, ...protectedRoutes };
}

function policy(
  surfaceRecipe: LingPresentationSurfacePolicy["surfaceRecipe"],
  artwork: LingPresentationSurfacePolicy["artwork"],
  decorations = false,
): LingPresentationSurfacePolicy {
  return Object.freeze({ surfaceRecipe, artwork, decorations });
}
