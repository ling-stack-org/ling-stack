import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BackgroundError, INITIAL_BACKGROUND, backgroundPayloadDigest, backgroundThemeProfile, type BackgroundPreference,
  type BackgroundRepository, type BackgroundSnapshot, type BackgroundPresentation, type BackgroundThemeProfile, type LingPresentationSurface } from "@ling-stack/ui-react/theme";
import { createBackgroundRepository } from "./background-repository-factory.js";
import { useTheme } from "../../../theme.js";
import { useBackgroundMotion } from "./useBackgroundMotion.js";

interface ContextValue {
  repository: BackgroundRepository; snapshot: BackgroundSnapshot; url?: string;
  ready: boolean; error?: string; saving: boolean;
  profile: BackgroundThemeProfile;
  presentation: { surface: LingPresentationSurface; visible: boolean };
  setPresentation(value: { surface: LingPresentationSurface; visible: boolean }): void;
  motion: { visible: boolean; reduced: boolean }; motionOverride: boolean;
  requestMotionPlay(value: boolean): void;
  playbackFailed: boolean; setPlaybackFailed(value: boolean): void;
  retryToken: number; retryPlayback(): void;
  refresh(): Promise<void>;
  apply(selection: BackgroundPreference["selection"], opacity: number, expectedRevision: number, leaseId?: string, presentation?: BackgroundPresentation): Promise<BackgroundPreference>;
}
const Context = createContext<ContextValue | undefined>(undefined);
export function useBackground(): ContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("BackgroundProvider is required");
  return value;
}
export function BackgroundProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { resolved } = useTheme();
  const motion = useBackgroundMotion();
  const [motionOverride, requestMotionPlay] = useState(false);
  const [presentation, setPresentationState] = useState<{ surface: LingPresentationSurface; visible: boolean }>({ surface: "home", visible: false });
  const setPresentation = useCallback((next: typeof presentation) => setPresentationState(current => current.surface === next.surface && current.visible === next.visible ? current : next), []);
  const [playbackFailed, setPlaybackFailed] = useState(false), [retryToken, setRetryToken] = useState(0);
  const retryPlayback = useCallback(() => { setPlaybackFailed(false); setRetryToken(value => value + 1); }, []);
  const [repository] = useState(createBackgroundRepository);
  const [snapshot, setSnapshot] = useState<BackgroundSnapshot>({ preference: INITIAL_BACKGROUND });
  const profile = backgroundThemeProfile(snapshot.preference, resolved.themeId);
  const assetId = snapshot.image?.asset.assetId;
  useEffect(() => { requestMotionPlay(false); setPlaybackFailed(false); }, [resolved.themeId, assetId, motion.reduced]);
  const [url, setUrl] = useState<string>();
  const [ready, setReady] = useState(false), [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const busy = useRef(false), generation = useRef(0), mounted = useRef(false);
  const active = useRef<{ assetId: string; url: string } | undefined>(undefined);
  const committed = useRef(INITIAL_BACKGROUND);
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  const pendingRefresh = useRef<Promise<void> | undefined>(undefined);
  const refreshRequested = useRef(false);
  const refresh = useCallback((): Promise<void> => {
    refreshRequested.current = true;
    if (pendingRefresh.current) return pendingRefresh.current;
    const work = async () => {
      while (refreshRequested.current && mounted.current) {
        refreshRequested.current = false;
        const current = ++generation.current;
        try {
          let next = await repository.read();
          if (!mounted.current || current !== generation.current) continue;
          let nextUrl: string | undefined;
          if (next.image) {
            if (active.current?.assetId === next.image.asset.assetId) nextUrl = active.current.url;
            else {
              nextUrl = URL.createObjectURL(new Blob([new Uint8Array(next.image.bytes)], { type: next.image.asset.mimeType }));
              if (next.image.asset.kind === "image") {
                try { const image = new Image(); image.src = nextUrl; await image.decode(); }
                catch { URL.revokeObjectURL(nextUrl); nextUrl = undefined; next = { ...next, resourceError: "corrupt" }; }
              }
            }
          }
          if (!mounted.current || current !== generation.current) { if (nextUrl && nextUrl !== active.current?.url) URL.revokeObjectURL(nextUrl); continue; }
          if (active.current?.url && active.current.url !== nextUrl) URL.revokeObjectURL(active.current.url);
          active.current = nextUrl && next.image ? { assetId: next.image.asset.assetId, url: nextUrl } : undefined;
          committed.current = next.preference;
          setUrl(nextUrl); setSnapshot(next); setReady(true); setError(undefined);
        } catch { if (mounted.current && current === generation.current) { setReady(false); setError("unavailable"); } }
      }
    };
    const promise = work().finally(() => { if (pendingRefresh.current === promise) pendingRefresh.current = undefined; });
    pendingRefresh.current = promise;
    return promise;
  }, [repository]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", focus);
    // Notifications carry no authority or data; every tab rereads the transaction.
    if (!window.lingDesktop && typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("ling-background-revision");
      channel.current.onmessage = () => void refresh();
    }
    return () => {
      mounted.current = false; generation.current++;
      window.removeEventListener("focus", focus);
      channel.current?.close(); channel.current = undefined;
      if (active.current) URL.revokeObjectURL(active.current.url);
      active.current = undefined;
    };
  }, [refresh]);
  const apply = async (selection: BackgroundPreference["selection"], opacity: number, expectedRevision: number, leaseId?: string, presentation?: BackgroundPresentation) => {
    if (busy.current) throw new BackgroundError("conflict");
    busy.current = true; setSaving(true);
    const intent = { selection, opacity, expectedRevision, ...(presentation ? { presentation } : {}) };
    const reconcileKnownCommit = (preference: BackgroundPreference) => {
      if (preference.revision <= committed.current.revision) return;
      // A confirmed commit remains authoritative even if its subsequent resource read fails.
      committed.current = preference;
      if (preference.selection.kind === "none" || preference.selection.assetId !== active.current?.assetId) {
        if (active.current) URL.revokeObjectURL(active.current.url);
        active.current = undefined; setUrl(undefined);
      }
      setSnapshot({ preference });
    };
    try {
      const saved = await repository.commit({ ...intent, requestId: crypto.randomUUID(), payloadDigest: await backgroundPayloadDigest(intent) });
      channel.current?.postMessage(null);
      await refresh();
      reconcileKnownCommit(saved);
      return committed.current;
    } catch (failure) {
      // A lost receipt may already have committed. Reconcile authority without replaying an older draft.
      const authority = await repository.read().catch(() => undefined);
      await refresh();
      const savedProfile = authority && presentation ? backgroundThemeProfile(authority.preference, presentation.themeId) : undefined;
      if (authority?.preference.revision !== expectedRevision + 1
        || (presentation ? savedProfile?.opacity !== opacity || savedProfile.focusX !== presentation.focusX || savedProfile.focusY !== presentation.focusY || savedProfile.paused !== presentation.paused : authority.preference.opacity !== opacity)
        || authority.preference.selection.kind !== selection.kind
        || selection.kind !== "none" && (authority.preference.selection.kind !== selection.kind || authority.preference.selection.assetId !== selection.assetId)) throw failure;
      reconcileKnownCommit(authority.preference);
      channel.current?.postMessage(null);
      return committed.current;
    } finally {
      if (leaseId) await repository.release(leaseId).catch(() => {});
      busy.current = false; if (mounted.current) setSaving(false);
    }
  };
  return <Context.Provider value={{ repository, snapshot, url, ready, error, saving, refresh, apply, profile,
    presentation, setPresentation, motion, motionOverride, requestMotionPlay, playbackFailed, setPlaybackFailed,
    retryToken, retryPlayback }}>{children}</Context.Provider>;
}
