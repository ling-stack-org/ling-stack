import { expect, type Locator } from "@playwright/test";

export async function expectMessageInteractionPolicy(
  row: Locator,
  kind: "assistant" | "state" | "user",
  actionLabel: string,
): Promise<void> {
  const actionBar = row.locator(".message-action-bar").first();
  const initial = await readMessageSurface(row);
  const transparent = "rgba(0, 0, 0, 0)";

  if (kind === "assistant") {
    expect(initial.backgroundColor).toBe(transparent);
    expect(initial.borderColors.every((color) => color === transparent)).toBe(true);
  } else if (kind === "user") {
    expect(initial.backgroundColor).not.toBe(transparent);
  } else {
    expect(initial.backgroundColor).not.toBe(transparent);
    expect(initial.borderColors.some((color) => color !== transparent)).toBe(true);
  }

  await expect.poll(() => actionBar.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThan(0.01);
  await row.hover();
  await expect.poll(() => actionBar.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeGreaterThan(0.99);
  expect(await readMessageSurface(row)).toEqual(initial);

  const action = actionBar.getByRole("button", { name: actionLabel, exact: true });
  await action.focus();
  await row.page().keyboard.press("Shift+Tab");
  await row.page().keyboard.press("Tab");
  await row.page().mouse.move(0, 0);
  await expect(action).toBeFocused();
  await expect.poll(() => actionBar.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeGreaterThan(0.99);
  expect(await readMessageSurface(row)).toEqual(initial);
  const focusRing = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(focusRing.style).not.toBe("none");
  expect(focusRing.width).toBeGreaterThanOrEqual(2);
}

async function readMessageSurface(row: Locator): Promise<{
  readonly backgroundColor: string;
  readonly borderColors: readonly string[];
  readonly boxShadow: string;
}> {
  return row.locator(":scope > .message-content").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
      boxShadow: style.boxShadow,
    };
  });
}
