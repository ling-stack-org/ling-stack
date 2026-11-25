import { useEffect, useRef, useState } from "react";
import { artifactContentUrl } from "../../../api/media.js";
import { useI18n } from "../../../i18n.js";
import type { RunArtifact } from "../../../types.js";
import { ConversationMediaArtifact } from "./ConversationMediaArtifact.js";

const frameIntervalMs = 180;

interface ConversationGeneratedMediaFrameViewerProps {
  readonly frames: readonly RunArtifact[];
  readonly cwd: string;
  readonly title: string;
}

export function ConversationGeneratedMediaFrameViewer({
  frames,
  cwd,
  title,
}: ConversationGeneratedMediaFrameViewerProps): React.JSX.Element {
  const { t } = useI18n();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const activeThumbnail = useRef<HTMLButtonElement>(null);
  const frameCount = frames.length;
  const currentFrame = frames[currentIndex];

  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = globalThis.setInterval(() => {
      setCurrentIndex((current) => (current + 1) % frameCount);
    }, frameIntervalMs);
    return () => globalThis.clearInterval(timer);
  }, [frameCount, playing]);

  useEffect(() => {
    const thumbnail = activeThumbnail.current;
    const strip = thumbnail?.parentElement;
    if (!thumbnail || !strip) return;

    const frameBounds = thumbnail.getBoundingClientRect();
    const stripBounds = strip.getBoundingClientRect();
    const leftOverflow = frameBounds.left - stripBounds.left;
    const rightOverflow = frameBounds.right - stripBounds.right;
    if (leftOverflow < 0) strip.scrollLeft += leftOverflow;
    else if (rightOverflow > 0) strip.scrollLeft += rightOverflow;
  }, [currentIndex]);

  function selectFrame(index: number): void {
    setPlaying(false);
    setCurrentIndex(index);
  }

  function startPlayback(): void {
    setCurrentIndex(0);
    setPlaying(true);
  }

  return (
    <section className="conversation-generated-media-frame-viewer" aria-label={title}>
      <header className="conversation-generated-media-frame-theme">
        <div className="conversation-generated-media-frame-theme-copy">
          <img
            className="conversation-generated-media-frame-cover"
            src={artifactContentUrl(frames[0].id, cwd)}
            alt=""
            loading="lazy"
          />
          <span>
            <strong title={title}>{title}</strong>
            <small>{playing ? t("Playing") : t("Ready")}</small>
          </span>
        </div>
        <div className="conversation-generated-media-frame-controls" role="group" aria-label={t("Frame playback controls")}>
          <button
            type="button"
            className="conversation-generated-media-frame-play"
            disabled={playing}
            onClick={startPlayback}
          >
            {t("Play")}
          </button>
          <button
            type="button"
            className="conversation-generated-media-frame-stop"
            disabled={!playing}
            onClick={() => selectFrame(0)}
          >
            {t("Stop")}
          </button>
        </div>
      </header>

      <div className="conversation-generated-media-frame-stage">
        <ConversationMediaArtifact artifact={currentFrame} cwd={cwd} generated />
      </div>

      <div className="conversation-generated-media-frame-strip" role="group" aria-label={t("Frames")}>
        {frames.map((frame, index) => (
          <button
            className="conversation-generated-media-frame-thumb"
            type="button"
            aria-pressed={index === currentIndex}
            aria-label={t("Frame {index}", { index: index + 1 })}
            ref={index === currentIndex ? activeThumbnail : undefined}
            key={frame.id}
            onClick={() => selectFrame(index)}
          >
            <img src={artifactContentUrl(frame.id, cwd)} alt="" loading="lazy" />
          </button>
        ))}
      </div>

      <div className="conversation-generated-media-frame-meta">
        <strong>{t("View frame")}</strong>
        <span>{currentIndex + 1} / {frameCount}</span>
      </div>

      <input
        className="conversation-generated-media-frame-scrubber"
        data-ling-control-native="true"
        type="range"
        min={1}
        max={frameCount}
        step={1}
        value={currentIndex + 1}
        aria-label={t("Select frame")}
        onChange={(event) => selectFrame(event.currentTarget.valueAsNumber - 1)}
      />
    </section>
  );
}
