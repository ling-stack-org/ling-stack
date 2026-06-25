import { useMemo, useState } from "react";
import { Columns2, Image as ImageIcon, SlidersHorizontal, ScanLine } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { PreviewImageCompare, PreviewImageCompareMode, PreviewImageCompareSource } from "../../../types.js";
import { notifyConversationDeferredContentReady } from "../blocks/deferred-rendering.js";

export interface ImageCompareViewerProps {
  readonly current: PreviewImageCompareSource;
  readonly compare?: PreviewImageCompare;
}

const compareModes: readonly PreviewImageCompareMode[] = ["single", "side_by_side", "slider", "diff_overlay"];

export function ImageCompareViewer({ current, compare }: ImageCompareViewerProps): JSX.Element {
  const { t } = useI18n();
  const availableModes = compare ? compareModes : (["single"] as const);
  const defaultMode = compare?.defaultMode && compareModes.includes(compare.defaultMode)
    ? compare.defaultMode
    : "single";
  const [mode, setMode] = useState<PreviewImageCompareMode>(defaultMode);
  const [sliderValue, setSliderValue] = useState(50);
  const activeMode = compare ? mode : "single";
  const before = compare?.before;
  const after = compare?.after ?? current;
  const sliderClip = useMemo(() => `${sliderValue}%`, [sliderValue]);

  return (
    <div className="image-compare-viewer">
      <div className="image-compare-toolbar" aria-label={t("Image compare mode")}>
        {availableModes.map((item) => (
          <button
            key={item}
            className={activeMode === item ? "active" : ""}
            type="button"
            aria-pressed={activeMode === item}
            onClick={() => setMode(item)}
          >
            {imageCompareModeIcon(item)}
            <span>{t(imageCompareModeLabel(item))}</span>
          </button>
        ))}
      </div>

      {activeMode === "single" || !before ? (
        <ImageFrame image={current} label={current.label} />
      ) : activeMode === "side_by_side" ? (
        <div className="image-compare-side-by-side">
          <ImageFrame image={before} label={t("Before")} />
          <ImageFrame image={after} label={t("After")} />
        </div>
      ) : activeMode === "slider" ? (
        <div className="image-compare-slider">
          <div className="image-compare-slider-stage">
            <img src={before.imageUrl} alt={before.label} loading="lazy" decoding="async" onLoad={(event) => notifyConversationDeferredContentReady(event.currentTarget)} />
            <img
              className="image-compare-slider-after"
              src={after.imageUrl}
              alt={after.label}
              loading="lazy"
              decoding="async"
              onLoad={(event) => notifyConversationDeferredContentReady(event.currentTarget)}
              style={{ clipPath: `inset(0 0 0 ${sliderClip})` }}
            />
            <span className="image-compare-slider-handle" style={{ left: sliderClip }} aria-hidden="true" />
          </div>
          <label className="image-compare-slider-control">
            <span>{t("Slider")}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={sliderValue}
              onChange={(event) => setSliderValue(Number(event.currentTarget.value))}
            />
          </label>
        </div>
      ) : (
        <div className="image-compare-diff-overlay">
          <img src={before.imageUrl} alt={before.label} loading="lazy" decoding="async" onLoad={(event) => notifyConversationDeferredContentReady(event.currentTarget)} />
          <img src={after.imageUrl} alt={after.label} loading="lazy" decoding="async" onLoad={(event) => notifyConversationDeferredContentReady(event.currentTarget)} />
        </div>
      )}
    </div>
  );
}

function ImageFrame({ image, label }: { readonly image: PreviewImageCompareSource; readonly label: string }): JSX.Element {
  return (
    <figure className="image-compare-frame">
      <img src={image.imageUrl} alt={image.label} loading="lazy" decoding="async" onLoad={(event) => notifyConversationDeferredContentReady(event.currentTarget)} />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function imageCompareModeLabel(mode: PreviewImageCompareMode): string {
  if (mode === "side_by_side") {
    return "Side by side";
  }
  if (mode === "slider") {
    return "Slider";
  }
  if (mode === "diff_overlay") {
    return "Diff overlay";
  }
  return "Single";
}

function imageCompareModeIcon(mode: PreviewImageCompareMode): JSX.Element {
  if (mode === "side_by_side") {
    return <Columns2 size={13} />;
  }
  if (mode === "slider") {
    return <SlidersHorizontal size={13} />;
  }
  if (mode === "diff_overlay") {
    return <ScanLine size={13} />;
  }
  return <ImageIcon size={13} />;
}
