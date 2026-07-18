export const computerUseScreenshotThemes = Object.freeze(["light", "dark"]);

export const computerUseScreenshotCases = Object.freeze([
  Object.freeze({ id: "minimum", width: 320, height: 200 }),
  Object.freeze({ id: "default", width: 420, height: 263 }),
  Object.freeze({ id: "maximum", width: 480, height: 300 }),
  Object.freeze({ id: "stop-failed", width: 420, height: 263, scenario: "stop-failed" }),
  Object.freeze({ id: "reduced-motion", width: 420, height: 263, scenario: "reduced-motion" }),
  Object.freeze({ id: "deck-stacked", width: 720, height: 450, scenario: "deck-stacked" }),
  Object.freeze({ id: "deck-tabs", width: 420, height: 263, scenario: "deck-tabs" }),
  Object.freeze({ id: "deck-view-all", width: 420, height: 263, scenario: "deck-view-all" }),
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
