import type {
  DesktopThemePackageBootstrapValue,
  DesktopThemePackageFirstPaintState,
} from "./theme-package-capabilities.js";

export const DESKTOP_THEME_PACKAGE_FIRST_PAINT_ARGUMENT =
  "--ling-theme-package-first-paint=";

const MAX_ARGUMENT_LENGTH = 24_000;
const MAX_READY_THEME_AUTHORITIES = 64;
const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function compareThemeIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createDesktopThemePackageFirstPaintState(
  bootstrap: DesktopThemePackageBootstrapValue,
): DesktopThemePackageFirstPaintState {
  const readyThemes = bootstrap.packages
    .filter((descriptor) => descriptor.health === "ready")
    .map((descriptor) => ({
      themeId: descriptor.themeId,
      packageChecksumSha256: descriptor.packageChecksumSha256,
    }))
    .sort((left, right) => compareThemeIds(left.themeId, right.themeId));
  const authorityComplete = readyThemes.length <= MAX_READY_THEME_AUTHORITIES
    && readyThemes.every((entry) => (
      typeof entry.packageChecksumSha256 === "string"
      && SHA256_PATTERN.test(entry.packageChecksumSha256)
    ));
  return Object.freeze({
    repositoryRevision: bootstrap.repositoryRevision,
    authorityComplete,
    readyThemes: Object.freeze(authorityComplete
      ? readyThemes.map((entry) => Object.freeze({
        themeId: entry.themeId,
        packageChecksumSha256: entry.packageChecksumSha256!,
      }))
      : []),
  });
}

export function encodeDesktopThemePackageFirstPaintArgument(
  state: DesktopThemePackageFirstPaintState,
): string {
  const validated = validateDesktopThemePackageFirstPaintState(state);
  if (!validated) {
    throw new TypeError("Invalid Desktop Theme Package first-paint state");
  }
  const argument = `${DESKTOP_THEME_PACKAGE_FIRST_PAINT_ARGUMENT}${encodeURIComponent(JSON.stringify(validated))}`;
  if (argument.length > MAX_ARGUMENT_LENGTH) {
    throw new RangeError("Desktop Theme Package first-paint state exceeds the argument budget");
  }
  return argument;
}

export function parseDesktopThemePackageFirstPaintArgument(
  argv: readonly string[],
): DesktopThemePackageFirstPaintState | undefined {
  const argumentsForAuthority = argv.filter((value) => value.startsWith(DESKTOP_THEME_PACKAGE_FIRST_PAINT_ARGUMENT));
  if (argumentsForAuthority.length !== 1) return undefined;
  const [argument] = argumentsForAuthority;
  if (!argument || argument.length > MAX_ARGUMENT_LENGTH) return undefined;
  try {
    const raw = argument.slice(DESKTOP_THEME_PACKAGE_FIRST_PAINT_ARGUMENT.length);
    return validateDesktopThemePackageFirstPaintState(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return undefined;
  }
}

export function validateDesktopThemePackageFirstPaintState(
  value: unknown,
): DesktopThemePackageFirstPaintState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<DesktopThemePackageFirstPaintState>;
  if (
    !Number.isSafeInteger(candidate.repositoryRevision)
    || (candidate.repositoryRevision ?? 0) < 1
    || typeof candidate.authorityComplete !== "boolean"
    || !Array.isArray(candidate.readyThemes)
    || candidate.readyThemes.length > MAX_READY_THEME_AUTHORITIES
  ) {
    return undefined;
  }
  const readyThemes = candidate.readyThemes;
  if (!candidate.authorityComplete && readyThemes.length > 0) return undefined;
  if (readyThemes.some((entry) => (
    !entry
    || typeof entry !== "object"
    || Array.isArray(entry)
    || typeof entry.themeId !== "string"
    || entry.themeId.length > 64
    || !THEME_ID_PATTERN.test(entry.themeId)
    || typeof entry.packageChecksumSha256 !== "string"
    || !SHA256_PATTERN.test(entry.packageChecksumSha256)
  ))) {
    return undefined;
  }
  const themeIds = readyThemes.map((entry) => entry.themeId);
  if (new Set(themeIds).size !== themeIds.length) return undefined;
  const sortedThemes = [...readyThemes].sort((left, right) => compareThemeIds(left.themeId, right.themeId));
  if (sortedThemes.some((entry, index) => entry.themeId !== readyThemes[index]?.themeId)) return undefined;
  return Object.freeze({
    repositoryRevision: candidate.repositoryRevision,
    authorityComplete: candidate.authorityComplete,
    readyThemes: Object.freeze(sortedThemes.map((entry) => Object.freeze({
      themeId: entry.themeId,
      packageChecksumSha256: entry.packageChecksumSha256,
    }))),
  }) as DesktopThemePackageFirstPaintState;
}
