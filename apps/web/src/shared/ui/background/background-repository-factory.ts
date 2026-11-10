import { BackgroundError, type BackgroundRepository } from "@ling-stack/ui-react/theme";
import type { DesktopBackgroundCapabilities, BackgroundReply } from "../../../../../desktop/shared/background-capabilities.js";
import { WebBackgroundRepository } from "./web-background-repository.js";

export function createBackgroundRepository(): BackgroundRepository {
  const desktop = window.lingDesktop;
  if (!desktop) return new WebBackgroundRepository();
  const capability = desktop.backgrounds;
  if (!capability || !["read", "prepare", "release", "commit"].every(key => typeof capability[key as keyof DesktopBackgroundCapabilities] === "function")) {
    const unavailable = async (): Promise<never> => { throw new BackgroundError("unavailable"); };
    return { read: unavailable, prepare: unavailable, release: unavailable, commit: unavailable };
  }
  const unwrap = async <T>(reply: Promise<BackgroundReply<T>>): Promise<T> => {
    const result = await reply;
    if (!result.ok) throw new BackgroundError(result.error);
    return result.value;
  };
  return { read: () => unwrap(capability.read()), prepare: input => unwrap(capability.prepare(input)),
    release: id => unwrap(capability.release(id)), commit: input => unwrap(capability.commit(input)) };
}
