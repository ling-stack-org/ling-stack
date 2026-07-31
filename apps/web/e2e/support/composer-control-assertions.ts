import { expect, type Locator } from "@playwright/test";

export async function expectCompactMutedComposerControl(control: Locator): Promise<void> {
  const style = await control.evaluate((element) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = rootStyle.getPropertyValue("--ling-text-muted");
    document.body.append(probe);
    const expectedColor = getComputedStyle(probe).color;
    probe.remove();

    const controlStyle = getComputedStyle(element);
    return {
      color: controlStyle.color,
      expectedColor,
      fontSize: controlStyle.fontSize,
      expectedFontSize: rootStyle.getPropertyValue("--ling-font-xs").trim(),
      fontWeight: controlStyle.fontWeight,
    };
  });

  expect(style.color).toBe(style.expectedColor);
  expect(style.fontSize).toBe(style.expectedFontSize);
  expect(style.fontWeight).toBe("500");
}
