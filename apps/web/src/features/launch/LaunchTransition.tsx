import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createLaunchAnimation,
  LAUNCH_ANIMATION_FADE_DURATION,
  type LaunchAnimationController,
} from "./launch-animation.js";
import { useTheme } from "../../theme.js";

export interface LaunchTransitionProps {
  readonly referenceImageUrl?: string;
  readonly onFinished?: () => void;
}

export function LaunchTransition({
  referenceImageUrl,
  onFinished,
}: LaunchTransitionProps): React.JSX.Element | null {
  const { readThemePackage, resolved } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<LaunchAnimationController | undefined>(undefined);
  const objectUrlRef = useRef<string | undefined>(undefined);
  const onFinishedRef = useRef(onFinished);
  const [exiting, setExiting] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useLayoutEffect(() => {
    const root = document.getElementById("root");
    if (!visible || !root) return undefined;
    const previousInert = root.inert;
    root.inert = true;
    return () => { root.inert = previousInert; };
  }, [visible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let fadeTimer: number | undefined;
    let controller: LaunchAnimationController;
    try {
      controller = createLaunchAnimation(canvas, {
        ...(referenceImageUrl !== undefined ? { referenceImageUrl } : {}),
        onComplete: () => {
          setExiting(true);
          fadeTimer = window.setTimeout(() => {
            setVisible(false);
            onFinishedRef.current?.();
          }, LAUNCH_ANIMATION_FADE_DURATION);
        },
      });
    } catch (error) {
      console.warn("Launch animation could not start.", error);
      setVisible(false);
      onFinishedRef.current?.();
      return undefined;
    }
    controllerRef.current = controller;

    return () => {
      controller?.destroy();
      controllerRef.current = undefined;
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
    };
  }, [referenceImageUrl]);

  useEffect(() => {
    const referenceImage = resolved.manifest.launchAnimation?.referenceImage;
    if (!referenceImage) return undefined;
    let cancelled = false;
    void readThemePackage(resolved.themeId)
      .then((storedPackage) => {
        const asset = storedPackage?.launchAnimation;
        if (cancelled || !asset || asset.path !== referenceImage) return;
        const url = URL.createObjectURL(asset.blob);
        const previousUrl = objectUrlRef.current;
        objectUrlRef.current = url;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        controllerRef.current?.setReferenceImageUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      const previousUrl = objectUrlRef.current;
      objectUrlRef.current = undefined;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    };
  }, [readThemePackage, resolved.manifest.launchAnimation?.referenceImage, resolved.themeId]);

  if (!visible) return null;

  const transition = (
    <div
      aria-hidden="true"
      className="ling-launch-transition"
      data-state={exiting ? "exiting" : "playing"}
      data-testid="ling-launch-transition"
    >
      <canvas ref={canvasRef} aria-label="Ling launch animation" />
    </div>
  );

  return typeof document === "undefined" ? transition : createPortal(transition, document.body);
}
