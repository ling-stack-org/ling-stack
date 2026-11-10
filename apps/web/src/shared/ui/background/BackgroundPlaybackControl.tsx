import { Pause, Play, RotateCcw } from "lucide-react";
import { useState } from "react";
import { BackgroundError, Button } from "@ling-stack/ui-react";
import { useI18n } from "../../../i18n.js";
import { useTheme } from "../../../theme.js";
import { useBackground } from "./BackgroundProvider.js";

export function BackgroundPlaybackControl(): React.JSX.Element {
  const background = useBackground(), { t } = useI18n(), { resolved } = useTheme();
  const [failure, setFailure] = useState<"conflict" | "save">();
  const { profile, motion, motionOverride } = background;
  const paused = profile.paused || motion.reduced && !motionOverride;
  const label = background.playbackFailed ? t("background.retry") : `${t(paused ? "Resume" : "Pause")} · ${t("background.title")}`;
  const toggle = async () => {
    if (background.playbackFailed) { background.retryPlayback(); return; }
    setFailure(undefined);
    try {
      await background.apply(background.snapshot.preference.selection, profile.opacity, background.snapshot.preference.revision, undefined,
        { themeId: resolved.themeId, focusX: profile.focusX, focusY: profile.focusY, paused: !paused });
      background.requestMotionPlay(paused);
    } catch (error) { setFailure(error instanceof BackgroundError && error.code === "conflict" ? "conflict" : "save"); }
  };
  return <div className="background-playback-controls" data-background-playback-controls>
    {background.playbackFailed ? <span role="status">{t("background.playbackError")}</span> : null}
    {failure ? <span role="alert">{t(failure === "conflict" ? "background.error.conflict" : "background.error.save")}</span> : null}
    <Button variant="secondary" size="sm" disabled={background.saving || !background.ready} onClick={() => void toggle()} aria-label={label} title={label}>
      {background.playbackFailed ? <RotateCcw aria-hidden="true" /> : paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
    </Button>
  </div>;
}
