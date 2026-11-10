import { builtInPresentationProfiles } from "./built-in-profiles.js";
import type {
  LingPresentationProfileDefinition,
  LingPresentationSurface,
  LingPresentationSurfaceContext,
  LingPresentationSurfacePolicy,
  LingThemeDecorationSet,
} from "./profile-types.js";
import type { LingThemeArtworkSlot } from "../types.js";

const COMPACT_PRESENTATION_WIDTH = 1280;
const MINIMUM_PRESENTATION_WIDTH = 1180;

export class PresentationProfileRegistry {
  private readonly profiles = new Map<string, LingPresentationProfileDefinition>();

  constructor(profiles: readonly LingPresentationProfileDefinition[] = builtInPresentationProfiles) {
    for (const profile of profiles) {
      if (this.profiles.has(profile.id)) {
        throw new Error(`Duplicate presentation profile: ${profile.id}`);
      }
      this.profiles.set(profile.id, profile);
    }
    if (!this.profiles.has("ling-standard")) {
      throw new Error("The ling-standard presentation profile is required.");
    }
  }

  list(): readonly LingPresentationProfileDefinition[] {
    return Object.freeze([...this.profiles.values()]);
  }

  get(profileId: string): LingPresentationProfileDefinition | undefined {
    return this.profiles.get(profileId);
  }

  resolveSurface(
    profileId: string,
    surface: LingPresentationSurface,
    context: LingPresentationSurfaceContext = {},
  ): LingPresentationSurfacePolicy {
    const profile = this.profileOrStandard(profileId, context.viewportWidth);
    const policy = profile.routePolicy[surface];
    const accessibilityFallback = context.reducedTransparency === true || context.forcedColors === true;
    const compact = context.viewportWidth !== undefined && context.viewportWidth <= COMPACT_PRESENTATION_WIDTH;

    if (accessibilityFallback) {
      return Object.freeze({
        surfaceRecipe: policy.surfaceRecipe === "domain" ? "domain" : "solid",
        artwork: "off",
        decorations: false,
      });
    }

    if (context.userBackground) {
      // Keep dense management surfaces opaque. The automation workspace opts
      // into the ambient scene explicitly because it shares the management
      // route for data and navigation purposes.
      const visible = (
        ["home", "sidebar", "conversation", "channel"].includes(surface)
        || (surface === "management" && context.ambientWorkspace === true)
      ) && (context.viewportWidth === undefined || context.viewportWidth >= MINIMUM_PRESENTATION_WIDTH);
      return Object.freeze({ surfaceRecipe: visible ? "translucent" : policy.surfaceRecipe === "domain" ? "domain" : "solid",
        artwork: visible ? "ambient" : "off", decorations: false });
    }

    return Object.freeze({
      surfaceRecipe: policy.surfaceRecipe,
      artwork: compact && policy.artwork === "strong" ? "ambient" : policy.artwork,
      decorations: policy.decorations && !compact,
    });
  }

  supportsArtworkSlot(profileId: string, slot: LingThemeArtworkSlot): boolean {
    return this.profiles.get(profileId)?.supportedArtworkSlots.includes(slot) ?? false;
  }

  supportsDecorationSet(profileId: string, decorationSet: LingThemeDecorationSet): boolean {
    return this.profiles.get(profileId)?.supportedDecorationSets.includes(decorationSet) ?? false;
  }

  private profileOrStandard(profileId: string, viewportWidth: number | undefined): LingPresentationProfileDefinition {
    if (viewportWidth !== undefined && viewportWidth < MINIMUM_PRESENTATION_WIDTH) {
      return this.profiles.get("ling-standard")!;
    }
    return this.profiles.get(profileId) ?? this.profiles.get("ling-standard")!;
  }
}
