import { useLayoutEffect, useState, type CSSProperties } from "react";
import { backgroundRecipe, backgroundSurfaceOpacity, resolveBackgroundPanelAlpha, resolveBackgroundSidebarAlpha, resolveBackgroundWorkspaceAlpha } from "@ling-stack/ui-react/theme";
import { SceneArtwork } from "@ling-stack/ui-react";
import { useTheme } from "../../../theme.js";
import { useBackground } from "./BackgroundProvider.js";
import { BackgroundVideo } from "./BackgroundVideo.js";
import { BackgroundPlaybackControl } from "./BackgroundPlaybackControl.js";
import { SwordLightTrail } from "./sword-light/SwordLightTrail.js";

export function useBackgroundMaterial(opacity: number) {
  const { resolved } = useTheme();
  const [basis, setBasis] = useState(readMaterialBasis);
  // Theme application is committed on the root before paint. Re-read after a
  // switch so preview and workspace consume exactly the same CSS parameters.
  useLayoutEffect(() => { setBasis(readMaterialBasis()); }, [resolved]);
  const tokens = resolved.manifest.tokens;
  const recipe = backgroundRecipe(opacity);
  const foregrounds = [tokens.text.default, tokens.text.muted, tokens.text.strong, tokens.text.link]
    .map(color => ({ color, minimum: 4.5 }));
  foregrounds.push({ color: tokens.border.focus, minimum: 3 });
  return {
    recipe,
    workspace: resolveBackgroundWorkspaceAlpha({
      app: tokens.background.app,
      panel: tokens.background.panel,
      opacity,
      baseAlpha: basis.ambient,
    }),
    panel: resolveBackgroundPanelAlpha({ app: tokens.background.app, panel: tokens.background.panel, opacity, foregrounds, minimumAlpha: basis.content }),
    sidebar: resolveBackgroundSidebarAlpha({ app: tokens.background.app, sidebar: tokens.background.sidebar, minimumAlpha: basis.shell }),
  };
}

function readMaterialBasis() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: number) => {
    const value = css.getPropertyValue(name).trim();
    return value && Number.isFinite(Number(value)) ? Number(value) : fallback;
  };
  return { ambient: read("--ling-surface-ambient-alpha", 0), content: read("--ling-surface-content-alpha", 0), shell: read("--ling-surface-shell-alpha", 0.68) };
}

export function useEffectiveBackgroundOpacity(opacity: number): number {
  const [width, setWidth] = useState(window.innerWidth);
  useLayoutEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update); return () => window.removeEventListener("resize", update);
  }, []);
  return width <= 1280 ? Math.min(opacity, 0.6) : opacity;
}

export function WorkspaceBackgroundLayer(): React.JSX.Element {
  const background = useBackground();
  const { url, snapshot, profile, presentation, motion, motionOverride } = background;
  const { resolved } = useTheme();
  const scene = resolved.manifest.scene?.id;
  const mediaKind = snapshot.image?.asset.kind;
  const opacity = useEffectiveBackgroundOpacity(backgroundSurfaceOpacity(profile.opacity, presentation.surface));
  const material = useBackgroundMaterial(opacity);
  const active = Boolean(url || scene);
  const source = url ? mediaKind === "video" ? "local-video" : "local-image" : scene ? "theme-scene" : "theme-solid";
  // Theme-scoped light trail: only the ink-wash journey scene opts in, and only
  // while decoration is allowed. Contract: docs/design/theme-background-motion-contract.md section 9.
  const glowCursor = scene === "farbound-journey" && motion.visible && !motion.reduced;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.userBackground = active ? "ready" : "off";
    root.dataset.backgroundSource = source;
    root.style.setProperty("--user-background-scrim", String(material.recipe.scrim));
    root.style.setProperty("--user-background-workspace", `${material.workspace * 100}%`);
    root.style.setProperty("--user-background-panel", `${material.panel * 100}%`);
    root.style.setProperty("--user-background-sidebar", `${material.sidebar * 100}%`);
    return () => {
      delete root.dataset.userBackground;
      delete root.dataset.backgroundSource;
      for (const name of ["--user-background-scrim", "--user-background-workspace", "--user-background-panel", "--user-background-sidebar"]) root.style.removeProperty(name);
    };
  }, [active, source, material.recipe.scrim, material.workspace, material.panel, material.sidebar]);

  const position = { x: profile.focusX, y: profile.focusY };
  const fallback = scene ? <SceneArtwork scene={scene} position={position} /> : undefined;
  return <><div className="workspace-background-layer" aria-hidden="true" data-background-layer
    style={{ "--background-focus-x": `${position.x}%`, "--background-focus-y": `${position.y}%` } as CSSProperties}>
    {url
      ? mediaKind === "video"
        ? <BackgroundVideo key={`${url}:${background.retryToken}`} url={url}
          enabled={presentation.visible && motion.visible} paused={profile.paused || motion.reduced && !motionOverride}
          fallback={fallback} onFailure={background.setPlaybackFailed} />
        : <img src={url} alt="" draggable={false} />
      : scene
        ? <SceneArtwork scene={scene} position={position} />
        : null}
    <div className="workspace-background-scrim" />
    {glowCursor ? <SwordLightTrail className="workspace-glow-cursor" color="#c49a63" secondaryColor="#9a7448" data-glow-cursor={scene} /> : null}
  </div>{url && mediaKind === "video" && presentation.visible ? <BackgroundPlaybackControl /> : null}</>;
}
