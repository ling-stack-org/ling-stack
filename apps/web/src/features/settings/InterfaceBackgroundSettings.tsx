import { ImagePlus } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Field, InlineFeedback, SceneArtwork, useFileDropFeedback, useLingToast, BACKGROUND_LIMITS, BACKGROUND_OPACITY,
  BACKGROUND_VIDEO_LIMITS, BackgroundError, backgroundVideoMimeType, backgroundThemeProfile, recommendedBackgroundProfile, type BackgroundImage } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { useTheme } from "../../theme.js";
import { useBackground } from "../../shared/ui/background/BackgroundProvider.js";
import { readVideoBackgroundMetadata } from "../../shared/ui/background/prepare-background-image.js";
import { BackgroundVideo } from "../../shared/ui/background/BackgroundVideo.js";
import { useBackgroundMaterial } from "../../shared/ui/background/WorkspaceBackgroundLayer.js";

interface Draft { image: BackgroundImage; url: string; leaseId: string; revision: number }
const BACKGROUND_SAVE_TOAST_SCOPE = "settings:background:save";

export function InterfaceBackgroundSettings(): React.JSX.Element {
  const { resolved } = useTheme();
  return <BackgroundSettingsEditor key={resolved.themeId} />;
}

function BackgroundSettingsEditor(): React.JSX.Element {
  const { t } = useI18n();
  const { showToast, dismissToast } = useLingToast();
  const { resolved } = useTheme();
  const background = useBackground(), preference = background.snapshot.preference;
  const [draft, setDraft] = useState<Draft>();
  const [opacity, setOpacity] = useState(background.profile.opacity);
  const [focusX, setFocusX] = useState(background.profile.focusX), [focusY, setFocusY] = useState(background.profile.focusY);
  const [paused, setPaused] = useState(background.profile.paused), [previewFailed, setPreviewFailed] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [opacityRevision, setOpacityRevision] = useState(preference.revision);
  const [processing, setProcessing] = useState(false), [failure, setFailure] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0), lease = useRef<string | undefined>(undefined), handedOff = useRef<string | undefined>(undefined);
  const draftRef = useRef<Draft | undefined>(undefined), queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const editing = useRef(false);
  const busy = background.saving;
  const dirty = Boolean(draft) || opacity !== background.profile.opacity || focusX !== background.profile.focusX || focusY !== background.profile.focusY || paused !== background.profile.paused;
  const recommended = recommendedBackgroundProfile();
  const differsFromRecommended = opacity !== recommended.opacity || focusX !== recommended.focusX || focusY !== recommended.focusY || paused !== recommended.paused;
  const revision = draft?.revision ?? opacityRevision;
  const conflict = dirty && revision !== preference.revision;
  // Preview the requested profile, independent of the settings window's size.
  // The actual workspace applies its own narrow-window and reading limits.
  const material = useBackgroundMaterial(opacity);
  const currentKind = draft?.image.asset.kind ?? background.snapshot.image?.asset.kind;
  const currentUrl = draft?.url ?? background.url;
  const scene = resolved.manifest.scene?.id;
  useEffect(() => { setPreviewFailed(false); }, [currentUrl]);

  const dispose = () => {
    generation.current++;
    if (lease.current && handedOff.current !== lease.current) void background.repository.release(lease.current).catch(() => {});
    lease.current = undefined;
    if (draftRef.current) URL.revokeObjectURL(draftRef.current.url);
    draftRef.current = undefined;
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; dispose(); };
  }, [background.repository]);
  const resetProfile = () => { const profile = background.profile; setOpacity(profile.opacity); setFocusX(profile.focusX); setFocusY(profile.focusY); setPaused(profile.paused); };
  useEffect(() => {
    if (!editing.current) { resetProfile(); setOpacityRevision(preference.revision); }
  }, [background.profile.opacity, background.profile.focusX, background.profile.focusY, background.profile.paused, preference.revision]);
  const beginEdit = () => { if (!dirty) setOpacityRevision(preference.revision); editing.current = true; };

  const cancel = () => {
    editing.current = false;
    dispose(); setDraft(undefined); setProcessing(false); resetProfile();
    setOpacityRevision(preference.revision); setFailure(undefined);
  };

  const select = (files: FileList | null) => {
    if (!files?.length || busy) return;
    if (files.length !== 1) { setFailure("multiple"); return; }
    const file = files[0];
    dispose(); setDraft(undefined); setFailure(undefined);
    const likelyVideo = file.type.startsWith("video/") || /\.(?:mp4|m4v|webm)$/iu.test(file.name);
    const limit = likelyVideo ? BACKGROUND_VIDEO_LIMITS.bytes : BACKGROUND_LIMITS.bytes;
    if (!file.size || file.size > limit) { setFailure("capacity"); setProcessing(false); return; }
    const current = generation.current, expectedRevision = preference.revision;
    editing.current = true;
    setProcessing(true); resetProfile(); setOpacityRevision(expectedRevision);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!mounted.current || current !== generation.current) return;
      const requestId = crypto.randomUUID(); lease.current = requestId;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (current !== generation.current) return;
        const videoType = backgroundVideoMimeType(bytes, file.name, file.type);
        const metadata = videoType ? await readVideoBackgroundMetadata(bytes, file.name, file.type) : undefined;
        const image = await background.repository.prepare({
          requestId,
          bytes,
          fileName: file.name,
          mimeType: file.type,
          ...(metadata ? { width: metadata.width, height: metadata.height, duration: metadata.duration } : {}),
        });
        if (!mounted.current || current !== generation.current) { await background.repository.release(requestId); return; }
        const url = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.asset.mimeType }));
        if (image.asset.kind === "image") {
          try { const preview = new Image(); preview.src = url; await preview.decode(); }
          catch { URL.revokeObjectURL(url); throw new BackgroundError("invalid-image"); }
        }
        if (!mounted.current || current !== generation.current) { URL.revokeObjectURL(url); await background.repository.release(requestId); return; }
        const next = { image, url, leaseId: requestId, revision: expectedRevision };
        draftRef.current = next; setDraft(next);
      } catch (error) {
        await background.repository.release(requestId).catch(() => {});
        if (mounted.current && current === generation.current) setFailure(error instanceof BackgroundError ? error.code : "invalid-image");
      } finally { if (mounted.current && current === generation.current) setProcessing(false); }
    });
  };

  const drop = useFileDropFeedback({ blocked: busy || !background.ready, resetKey: String(preference.revision), onFiles: select });

  const apply = async (clear = false) => {
    setFailure(undefined); dismissToast(BACKGROUND_SAVE_TOAST_SCOPE);
    const candidate = draftRef.current;
    if (candidate) handedOff.current = candidate.leaseId;
    try {
      const result = await background.apply(
        clear ? { kind: "none" } : candidate
          ? candidate.image.asset.kind === "video"
            ? { kind: "local-video", assetId: candidate.image.asset.assetId }
            : { kind: "local-image", assetId: candidate.image.asset.assetId }
          : preference.selection,
        clear ? background.profile.opacity : opacity,
        clear ? preference.revision : revision,
        candidate?.leaseId,
        { themeId: resolved.themeId, focusX: clear ? background.profile.focusX : focusX, focusY: clear ? background.profile.focusY : focusY, paused: clear ? background.profile.paused : paused },
      );
      if (mounted.current) {
        editing.current = false; dispose(); setDraft(undefined); setProcessing(false);
        const profile = backgroundThemeProfile(result, resolved.themeId);
        setOpacity(profile.opacity); setFocusX(profile.focusX); setFocusY(profile.focusY); setPaused(profile.paused); setOpacityRevision(result.revision); setFailure(undefined);
        showToast({ message: t("background.saved"), scope: BACKGROUND_SAVE_TOAST_SCOPE, tone: "success" });
      }
    } catch (error) {
      if (mounted.current) {
        dispose(); setDraft(undefined); editing.current = false; resetProfile(); setOpacityRevision(background.snapshot.preference.revision);
        setFailure(error instanceof BackgroundError ? error.code : "unavailable");
      }
    } finally { handedOff.current = undefined; }
  };

  const message = conflict || failure === "conflict" ? t("background.error.conflict")
    : failure === "multiple" ? t("background.error.multiple")
    : failure === "capacity" ? t("background.error.capacity")
    : failure === "invalid-image" || failure === "invalid-request" ? t("background.error.image")
    : failure ? t("background.error.save")
    : background.error ? t("background.error.storage")
    : background.snapshot.resourceError ? t("background.error.corrupt") : undefined;

  const previewPaused = paused || background.motion.reduced && !background.motionOverride;
  return <section className="settings-interface-section background-settings" aria-labelledby="background-title" data-background-settings>
    <header className="settings-interface-section-header"><ImagePlus aria-hidden="true" /><h2 id="background-title">{t("background.title")}</h2></header>
    <p className="background-description">{t("background.description")} {t("background.themeHint")}</p>
    <div className="background-editor" data-drop-active={drop.active || undefined} onDragOver={drop.onDragOver} onDragLeave={drop.onDragLeave} onDrop={drop.onDrop}>
      {drop.feedback}
      <div className="background-preview" aria-hidden="true" data-background-preview data-draft={dirty} style={{ "--background-focus-x": `${focusX}%`, "--background-focus-y": `${focusY}%`, "--preview-scrim": material.recipe.scrim, "--preview-panel": `${material.panel * 100}%`, "--preview-sidebar": `${material.sidebar * 100}%` } as CSSProperties}>
        {currentUrl
          ? currentKind === "video"
            ? <BackgroundVideo key={`${currentUrl}:${previewRetry}:${background.retryToken}`} url={currentUrl}
              enabled={background.motion.visible} paused={previewPaused} onFailure={setPreviewFailed}
              fallback={scene ? <SceneArtwork scene={scene} position={{ x: focusX, y: focusY }} /> : undefined} />
            : <img src={currentUrl} alt="" draggable={false} />
          : scene
            ? <SceneArtwork scene={scene} position={{ x: focusX, y: focusY }} />
            : null}
        <div className="background-preview-scrim" /><div className="background-preview-shell"><span /><span><i /><i /><i /></span><span /></div>
      </div>
      <div className="background-controls">
        <Field label={t("background.strength")}>
          <div className="background-opacity-control">
            <input
              aria-label={t("background.strength")}
              data-background-opacity
              data-ling-control-native="true"
              type="range"
              min={Math.round(BACKGROUND_OPACITY.minimum * 100)}
              max={Math.round(BACKGROUND_OPACITY.maximum * 100)}
              step="1"
              value={Math.round(opacity * 100)}
              disabled={busy || !background.ready}
              onChange={event => {
                beginEdit();
                setOpacity(Number(event.currentTarget.value) / 100);
              }}
            />
            <span>{Math.round(opacity * 100)}%</span>
          </div>
        </Field>
        {([{ label: "background.focusX", value: focusX, set: setFocusX, axis: "x" }, { label: "background.focusY", value: focusY, set: setFocusY, axis: "y" }] as const).map(control =>
          <Field key={control.axis} label={t(control.label)}>
            <div className="background-opacity-control">
              <input type="range" min="0" max="100" step="1" data-ling-control-native="true" data-background-focus={control.axis}
                aria-label={t(control.label)} value={control.value} disabled={busy || !background.ready || !(currentUrl || scene)}
                onChange={event => { beginEdit(); control.set(Number(event.currentTarget.value)); }} />
              <span>{control.value}%</span>
            </div>
          </Field>)}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,.mp4,.m4v,.webm" hidden data-ling-control-native="true" data-background-file onChange={event => { select(event.target.files); event.target.value = ""; }} />
        <div className="background-actions">
          <Button variant="secondary" disabled={busy || !background.ready} onClick={() => input.current?.click()}>{t("background.choose")}</Button>
          {dirty ? <><Button disabled={busy || processing || conflict || !background.ready} onClick={() => void apply()}>{busy ? t("background.saving") : t("background.apply")}</Button>
            <Button variant="secondary" disabled={busy} onClick={cancel}>{t("background.cancel")}</Button></> : null}
          {differsFromRecommended ? <Button variant="secondary" disabled={busy || !background.ready} onClick={() => {
            beginEdit();
            setOpacity(recommended.opacity); setFocusX(recommended.focusX); setFocusY(recommended.focusY); setPaused(recommended.paused);
          }}>{t("background.recommend")}</Button> : null}
          {currentKind === "video" ? <Button variant="secondary" disabled={busy} onClick={() => {
            beginEdit(); setPaused(!previewPaused); background.requestMotionPlay(previewPaused);
          }}>{t(previewPaused ? "Resume" : "Pause")} · {t("background.title")}</Button> : null}
          {previewFailed || background.playbackFailed ? <Button variant="secondary" onClick={() => {
            setPreviewFailed(false); setPreviewRetry(value => value + 1); background.retryPlayback();
          }}>{t("background.retry")}</Button> : null}
          {preference.selection.kind !== "none" ? <Button variant="secondary" disabled={busy || !background.ready} onClick={() => { dispose(); setDraft(undefined); setProcessing(false); void apply(true); }}>{t("background.clear")}</Button> : null}
          {!background.ready ? <Button variant="secondary" onClick={() => void background.refresh()}>{t("background.retry")}</Button> : null}
        </div>
        {background.motion.reduced && !background.motionOverride && currentKind === "video" ? <p className="background-size-note">{t("background.reducedMotion")}</p> : null}
        {previewFailed || background.playbackFailed ? <InlineFeedback tone="danger">{t("background.playbackError")}</InlineFeedback> : null}
        <div role="status" aria-live="polite">{processing ? t("background.processing") : dirty ? t("background.draft") : preference.selection.kind === "none" ? t("background.empty") : t("background.current")}</div>
        {draft ? <p className="background-size-note">{t("background.optimized", { width: draft.image.asset.width, height: draft.image.asset.height })}</p> : null}
      </div>
    </div>
    {message ? <InlineFeedback tone="danger">{message}</InlineFeedback> : null}
  </section>;
}
