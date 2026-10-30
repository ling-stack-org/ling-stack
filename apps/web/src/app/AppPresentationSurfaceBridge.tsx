import {
  PresentationProfileRegistry,
  type LingPresentationSurface,
} from "../shared/ui/index.js";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTheme } from "../theme.js";
import { useBackground } from "../shared/ui/background/BackgroundProvider.js";
import type { ViewId } from "./view-types.js";

const profileRegistry = new PresentationProfileRegistry();

export function AppPresentationSurfaceBridge(props: {
  readonly activeView: ViewId;
  readonly hasSelectedChannel: boolean;
  readonly hasSelectedConversation: boolean;
  readonly hasSelectedTeammate: boolean;
}): null {
  const { resolved } = useTheme();
  const { url, setPresentation } = useBackground();
  const environment = usePresentationEnvironment();
  const surface = resolveAppPresentationSurface(props);
  const policy = useMemo(() => profileRegistry.resolveSurface(
    resolved.presentationProfileId,
    surface,
    {
      ...environment,
      // Ordinary workspaces are allowed to keep the selected scene visible.
      // Settings, diagnostics, approvals and the media canvas remain opaque
      // because they are dense or full-screen workflows.
      ambientWorkspace: !["settings", "media", "runs", "threads", "approvals"].includes(props.activeView),
      userBackground: Boolean(url || resolved.manifest.scene),
    },
  ), [environment, props.activeView, resolved.manifest.scene, resolved.presentationProfileId, surface, url]);

  useLayoutEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    root.dataset.uiSurface = surface;
    root.dataset.uiSurfaceRecipe = policy.surfaceRecipe;
    root.dataset.uiArtworkPolicy = policy.artwork;
    root.dataset.uiDecorationPolicy = policy.decorations ? "on" : "off";
    setPresentation({ surface, visible: policy.surfaceRecipe === "translucent" && policy.artwork !== "off" });
  }, [policy, surface, setPresentation]);

  useEffect(() => () => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    delete root.dataset.uiSurface;
    delete root.dataset.uiSurfaceRecipe;
    delete root.dataset.uiArtworkPolicy;
    delete root.dataset.uiDecorationPolicy;
  }, []);

  return null;
}

export function resolveAppPresentationSurface(input: {
  readonly activeView: ViewId;
  readonly hasSelectedChannel: boolean;
  readonly hasSelectedConversation: boolean;
  readonly hasSelectedTeammate: boolean;
}): LingPresentationSurface {
  if (input.activeView === "workspace") {
    if (input.hasSelectedChannel) return "channel";
    if (input.hasSelectedConversation) return "conversation";
    return "home";
  }
  if (input.activeView === "teammates") return input.hasSelectedTeammate ? "conversation" : "management";
  if (input.activeView === "settings") return "settings";
  if (input.activeView === "media") return "media-canvas";
  if (input.activeView === "runs" || input.activeView === "threads") return "diagnostics";
  if (input.activeView === "approvals") return "approvals";
  return "management";
}

function usePresentationEnvironment(): {
  readonly viewportWidth: number;
  readonly reducedTransparency: boolean;
  readonly forcedColors: boolean;
} {
  const [environment, setEnvironment] = useState(readPresentationEnvironment);
  useEffect(() => {
    const reducedTransparency = safeMatchMedia("(prefers-reduced-transparency: reduce)");
    const forcedColors = safeMatchMedia("(forced-colors: active)");
    const update = (): void => setEnvironment(readPresentationEnvironment());
    globalThis.window?.addEventListener("resize", update);
    reducedTransparency?.addEventListener("change", update);
    forcedColors?.addEventListener("change", update);
    return () => {
      globalThis.window?.removeEventListener("resize", update);
      reducedTransparency?.removeEventListener("change", update);
      forcedColors?.removeEventListener("change", update);
    };
  }, []);
  return environment;
}

function readPresentationEnvironment() {
  return {
    viewportWidth: globalThis.window?.innerWidth ?? 1440,
    reducedTransparency: safeMatchMedia("(prefers-reduced-transparency: reduce)")?.matches ?? false,
    forcedColors: safeMatchMedia("(forced-colors: active)")?.matches ?? false,
  };
}

function safeMatchMedia(query: string): MediaQueryList | undefined {
  try {
    return globalThis.matchMedia?.(query);
  } catch {
    return undefined;
  }
}
