import type { BackgroundErrorCode, BackgroundImage, BackgroundPreference, BackgroundSnapshot,
  CommitBackgroundRequest, PrepareBackgroundRequest } from "@ling-stack/ui-react/theme";

export const BACKGROUND_CHANNELS = Object.freeze({ read: "ling-desktop:background:read", prepare: "ling-desktop:background:prepare",
  release: "ling-desktop:background:release", commit: "ling-desktop:background:commit" });
export type BackgroundReply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BackgroundErrorCode };
export interface DesktopBackgroundCapabilities {
  read(): Promise<BackgroundReply<BackgroundSnapshot>>;
  prepare(request: PrepareBackgroundRequest): Promise<BackgroundReply<BackgroundImage>>;
  release(requestId: string): Promise<BackgroundReply<void>>;
  commit(request: CommitBackgroundRequest): Promise<BackgroundReply<BackgroundPreference>>;
}
