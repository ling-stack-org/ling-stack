export type LocalPublicAssetPath = `${"avatars" | "brand" | "icons"}/${string}`;

const publicAssetBaseUrl = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

export function publicAssetUrl(assetPath: LocalPublicAssetPath): string {
  assertLocalPublicAssetPath(assetPath);
  return `${publicAssetBaseUrl}${assetPath}`;
}

function assertLocalPublicAssetPath(assetPath: string): void {
  const segments = assetPath.split("/");
  if (
    assetPath.startsWith("/")
    || assetPath.includes("\\")
    || assetPath.includes(":")
    || assetPath.includes("?")
    || assetPath.includes("#")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Public asset paths must be trusted local paths relative to the build base");
  }
}
