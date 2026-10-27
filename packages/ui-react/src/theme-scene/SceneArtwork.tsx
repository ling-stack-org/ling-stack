import { useEffect, useRef, useState } from "react";
import type { LingBuiltInSceneId } from "../theme/types.js";

export interface SceneArtworkProps {
  readonly scene: LingBuiltInSceneId;
  readonly className?: string;
  readonly compact?: boolean;
  readonly position?: { readonly x: number; readonly y: number };
}

export function SceneArtwork({ scene, className, compact = false, position }: SceneArtworkProps): React.JSX.Element {
  const ref = useRef<SVGSVGElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const positioned = Boolean(position);
  useEffect(() => {
    if (!positioned || !ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width && entry.contentRect.height) setAspect(entry.contentRect.width / entry.contentRect.height);
    });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [positioned]);
  const cropWidth = Math.min(1600, 900 * aspect), cropHeight = Math.min(900, 1600 / aspect);
  const viewBox = position ? `${(1600 - cropWidth) * position.x / 100} ${(900 - cropHeight) * position.y / 100} ${cropWidth} ${cropHeight}`
    : compact && scene === "farbound-journey" ? "0 250 1600 650" : "0 0 1600 900";
  const asset = sceneAssets[scene];
  return (
    <svg
      ref={ref}
      aria-hidden="true"
      className={className ?? "ling-scene-artwork"}
      data-compact={compact ? "true" : undefined}
      data-scene={scene}
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
      role="presentation"
      viewBox={viewBox}
    >
      <image
        href={compact ? asset.thumbnail : asset.background}
        height="900"
        preserveAspectRatio="xMidYMid slice"
        width="1600"
        x="0"
        y="0"
      />
    </svg>
  );
}

// Stable scene IDs preserve saved theme/profile selections; each scene is one
// complete image. Cards use a small export of that same source, never a second
// drawing or a separately positioned mascot.
const sceneAssets: Record<LingBuiltInSceneId, { background: string; thumbnail: string }> = {
  "forest-breeze": {
    background: "/themes/ling-breeze/forest-morning-v1.webp",
    thumbnail: "/themes/ling-breeze/forest-morning-v1-thumb.webp",
  },
  "ocean-drift": {
    background: "/themes/ling-ocean/salt-coast-v1.webp",
    thumbnail: "/themes/ling-ocean/salt-coast-v1-thumb.webp",
  },
  "midnight-aurora": {
    background: "/themes/ling-night/rain-window-v2.webp",
    thumbnail: "/themes/ling-night/rain-window-v2-thumb.webp",
  },
  "farbound-journey": {
    background: "/themes/ling-journey/ling-journey-v4-depth-dark.webp",
    thumbnail: "/themes/ling-journey/ling-journey-v4-depth-dark.webp",
  },
};
