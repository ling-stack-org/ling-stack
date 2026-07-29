import type { LingThemeImageDecoder } from "@ling-stack/ui-react/theme";

export const decodeDesktopThemeImage: LingThemeImageDecoder = async ({ bytes }) => {
  const { nativeImage } = await import("electron");
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) throw new Error("invalid_theme_preview");
  const { height, width } = image.getSize();
  return Object.freeze({ height, width });
};
