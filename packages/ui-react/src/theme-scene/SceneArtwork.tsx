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
  const asset = sceneAssets[scene];
  const viewBox = position ? `${(1600 - cropWidth) * position.x / 100} ${(900 - cropHeight) * position.y / 100} ${cropWidth} ${cropHeight}`
    : compact ? asset.thumbnailViewBox ?? "0 0 1600 900" : "0 0 1600 900";
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
const sceneAssets: Record<LingBuiltInSceneId, { background: string; thumbnail: string; thumbnailViewBox?: string }> = {
  "forest-breeze": {
    background: "/themes/ling-breeze/forest-clearing-v1.webp",
    thumbnail: "/themes/ling-breeze/forest-clearing-v1-thumb.webp",
  },
  "ocean-drift": {
    background: "/themes/ling-ocean/summer-manga-v1.webp",
    thumbnail: "/themes/ling-ocean/summer-manga-v1-thumb.webp",
    thumbnailViewBox: "0 0 1600 420",
  },
  "midnight-aurora": {
    background: "/themes/ling-night/valley-overlook-v1.webp",
    thumbnail: "/themes/ling-night/valley-overlook-v1-thumb.webp",
    thumbnailViewBox: "0 0 1600 360",
  },
  "farbound-journey": {
    background: "/themes/ling-journey/ling-journey-v4-depth-dark.webp",
    thumbnail: "/themes/ling-journey/ling-journey-v4-depth-dark.webp",
    thumbnailViewBox: "0 250 1600 650",
  },
};
