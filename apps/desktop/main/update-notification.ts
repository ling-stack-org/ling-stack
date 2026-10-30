import type { MessageBoxOptions } from "electron";

export const LING_RELEASE_API_URL = "https://api.github.com/repos/ling-stack-org/ling-stack/releases/latest";
const LING_RELEASE_URL_PREFIX = "https://github.com/ling-stack-org/ling-stack/releases/tag/";
const MIN_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type Version = readonly [number, number, number];

export interface DesktopUpdateNotice {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly releaseUrl: string;
}

export interface DesktopUpdateCheckOptions {
  readonly currentVersion: string;
  readonly fetchRelease: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
}

function parseStableVersion(value: unknown): Version | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return [major, minor, patch];
}

function isNewer(candidate: Version, installed: Version): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] !== installed[index]) return candidate[index] > installed[index];
  }
  return false;
}

/** A published stable GitHub Release is the only source of an update notice. */
export async function checkDesktopUpdate(options: DesktopUpdateCheckOptions): Promise<DesktopUpdateNotice | undefined> {
  const installed = parseStableVersion(options.currentVersion);
  if (!installed) return undefined;
  const response = await options.fetchRelease(LING_RELEASE_API_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Ling-Stack-Desktop" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return undefined;
  const release: unknown = await response.json();
  if (!release || typeof release !== "object" || Array.isArray(release)) return undefined;
  const value = release as Record<string, unknown>;
  if (value.draft !== false || value.prerelease !== false || typeof value.published_at !== "string") return undefined;
  const latest = parseStableVersion(value.tag_name);
  if (!latest || !isNewer(latest, installed)) return undefined;
  const tag = value.tag_name as string;
  if (value.html_url !== `${LING_RELEASE_URL_PREFIX}${tag}`) return undefined;
  return { currentVersion: options.currentVersion, latestVersion: latest.join("."), releaseUrl: value.html_url };
}

export function createDesktopUpdateNotification(options: {
  readonly packaged: boolean;
  readonly currentVersion: string;
  readonly locale: string;
  readonly fetchRelease?: DesktopUpdateCheckOptions["fetchRelease"];
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<{ readonly response: number }>;
  readonly openExternal: (url: string) => Promise<unknown>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}): { check(): Promise<void> } {
  let checkedAt = -Infinity;
  let inFlight: Promise<void> | undefined;
  let lastNotifiedVersion: string | undefined;
  const now = options.now ?? Date.now;
  return {
    check(): Promise<void> {
      if (!options.packaged || !parseStableVersion(options.currentVersion)) return Promise.resolve();
      if (inFlight) return inFlight;
      const time = now();
      if (time - checkedAt < MIN_CHECK_INTERVAL_MS) return Promise.resolve();
      checkedAt = time;
      const run = (async () => {
        try {
          const notice = await checkDesktopUpdate({
            currentVersion: options.currentVersion,
            fetchRelease: options.fetchRelease ?? fetch,
          });
          if (!notice || notice.latestVersion === lastNotifiedVersion) return;
          const chinese = options.locale.toLowerCase().startsWith("zh");
          const result = await options.showMessageBox({
            type: "info",
            title: chinese ? "Ling 有新版本" : "Ling update available",
            message: chinese
              ? `发现新版本 ${notice.latestVersion}（当前 ${notice.currentVersion}）`
              : `Version ${notice.latestVersion} is available (installed: ${notice.currentVersion})`,
            detail: chinese
              ? "可前往 GitHub Release 查看版本说明并手动下载；Ling 不会自动下载或安装。"
              : "Open the GitHub Release to review and download it manually. Ling will not download or install updates automatically.",
            buttons: chinese ? ["查看发布页面", "稍后"] : ["View release", "Later"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          lastNotifiedVersion = notice.latestVersion;
          if (result.response === 0) await options.openExternal(notice.releaseUrl);
        } catch (error) {
          try { options.onError?.(error); } catch { /* Diagnostics must not interrupt startup. */ }
        }
      })();
      inFlight = run.finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
