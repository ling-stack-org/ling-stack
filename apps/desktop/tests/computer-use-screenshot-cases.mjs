export const computerUseScreenshotThemes = Object.freeze(["light", "dark"]);

export const computerUseScreenshotCases = Object.freeze([
  Object.freeze({ id: "minimum", width: 320, height: 200 }),
  Object.freeze({ id: "default", width: 420, height: 263 }),
  Object.freeze({ id: "maximum", width: 480, height: 300 }),
  Object.freeze({ id: "stop-failed", width: 420, height: 263, scenario: "stop-failed" }),
  Object.freeze({ id: "reduced-motion", width: 420, height: 263, scenario: "reduced-motion" }),
]);

export function expectedComputerUseScreenshotManifestCases() {
  return computerUseScreenshotThemes.flatMap((theme) => (
    computerUseScreenshotCases.map((screenshotCase) => ({
      filename: `${screenshotCase.id}-${theme}.png`,
      theme,
      width: screenshotCase.width,
      height: screenshotCase.height,
      reducedMotion: screenshotCase.scenario === "reduced-motion",
    }))
  ));
}
