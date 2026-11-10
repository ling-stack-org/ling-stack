import { useEffect, useRef, useState } from "react";

/** One player for the scene and preview. No hidden decoder or second autoplay. */
export function BackgroundVideo({ url, enabled, paused, onFailure, fallback }: {
  readonly url: string;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly onFailure?: (failed: boolean) => void;
  readonly fallback?: React.JSX.Element;
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const [intersecting, setIntersecting] = useState(false);
  const [poster, setPoster] = useState<string>();
  const [failed, setFailed] = useState(false);
  const notify = useRef(onFailure); notify.current = onFailure;
  const allowed = useRef(false);
  allowed.current = enabled && !paused && intersecting && !failed;
  const recovery = useRef(0);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
    observer.observe(video);
    return () => observer.disconnect();
  }, [failed]);

  useEffect(() => {
    const video = ref.current;
    if (!video || failed) return;
    let disposed = false, lastProgress = performance.now(), lastTime = video.currentTime;
    const fail = () => { if (!disposed) { video.pause(); setFailed(true); notify.current?.(true); } };
    const update = () => {
      if (!allowed.current || document.hidden) { video.pause(); return; }
      void video.play().then(() => {
        // A late play promise must not restart a now-hidden player.
        if (disposed || !allowed.current || document.hidden) video.pause();
      }).catch(error => {
        if (!disposed && allowed.current && error?.name !== "AbortError") fail();
      });
    };
    let captured = false;
    const capture = () => {
      if (captured || video.readyState < 2 || !video.videoWidth) return;
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1280 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        setPoster(canvas.toDataURL("image/jpeg", 0.85)); captured = true;
      } catch { /* Local media normally permits a poster; theme fallback remains available. */ }
    };
    const ready = () => { capture(); update(); };
    const restore = () => {
      lastProgress = performance.now();
      if (video.readyState >= 2 && Number.isFinite(video.duration)) {
        // Request a fresh decoded frame after a window/page restoration.
        video.currentTime = Math.min(video.currentTime + 0.001, Math.max(0, video.duration - 0.001));
      }
      update();
    };
    const timer = window.setInterval(() => {
      if (!allowed.current || document.hidden) { lastProgress = performance.now(); return; }
      if (Math.abs(video.currentTime - lastTime) > 0.02) { lastTime = video.currentTime; lastProgress = performance.now(); return; }
      if (performance.now() - lastProgress < 8000) return;
      if (recovery.current++ >= 1) { fail(); return; }
      lastProgress = performance.now(); video.load(); update();
    }, 1000);
    video.addEventListener("loadeddata", ready);
    video.addEventListener("canplay", update);
    video.addEventListener("error", fail);
    window.addEventListener("pageshow", restore);
    window.addEventListener("focus", restore);
    document.addEventListener("visibilitychange", update);
    ready();
    return () => {
      disposed = true; window.clearInterval(timer); video.pause();
      video.removeEventListener("loadeddata", ready); video.removeEventListener("canplay", update); video.removeEventListener("error", fail);
      window.removeEventListener("pageshow", restore); window.removeEventListener("focus", restore); document.removeEventListener("visibilitychange", update);
    };
  }, [url, enabled, paused, intersecting, failed]);

  if (failed) return poster
    ? <img src={poster} alt="" draggable={false} data-background-video-fallback="poster" />
    : <div className="background-video-fallback" data-background-video-fallback="theme">{fallback}</div>;
  return <video ref={ref} src={url} muted loop playsInline preload="auto" disablePictureInPicture
    poster={poster} data-background-video data-playback-policy={enabled ? paused ? "paused" : "playing" : "hidden"} />;
}
