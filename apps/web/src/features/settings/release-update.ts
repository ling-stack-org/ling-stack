export const LING_RELEASE_API_URL = "https://api.github.com/repos/ling-stack-org/ling-stack/releases/latest";
export const LING_RELEASE_PAGE_URL = "https://github.com/ling-stack-org/ling-stack/releases";
const LING_RELEASE_TAG_PREFIX = "https://github.com/ling-stack-org/ling-stack/releases/tag/";

type StableVersion = readonly [number, number, number];

export interface ReleaseUpdate {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly releaseUrl: string;
  readonly publishedAt: string;
}

export interface ReleaseCheckOptions {
  readonly currentVersion: string;
  readonly fetchRelease?: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
}

function parseStableVersion(value: unknown): StableVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) return undefined;
  const version = match.slice(1).map(Number);
  return version.every(Number.isSafeInteger) ? version as unknown as StableVersion : undefined;
}

function isNewer(candidate: StableVersion, installed: StableVersion): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== installed[index]) return candidate[index] > installed[index];
  }
  return false;
}

export async function fetchReleaseUpdate(options: ReleaseCheckOptions): Promise<ReleaseUpdate | undefined> {
  const installed = parseStableVersion(options.currentVersion);
  if (!installed) return undefined;
  const fetchRelease = options.fetchRelease ?? fetch;
  const response = await fetchRelease(LING_RELEASE_API_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Ling-Stack-Web" },
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
  const releaseUrl = value.html_url;
  if (releaseUrl !== `${LING_RELEASE_TAG_PREFIX}${tag}`) return undefined;
  return {
    currentVersion: options.currentVersion,
    latestVersion: latest.join("."),
    releaseUrl,
    publishedAt: value.published_at,
  };
}

export function formatReleaseDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
