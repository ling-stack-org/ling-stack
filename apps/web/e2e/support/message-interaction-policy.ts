import { expect, type Locator } from "@playwright/test";
import { timelineResponseFooter } from "./timeline-response-footer";

export async function expectMessageInteractionPolicy(
  row: Locator,
  kind: "assistant" | "state" | "user",
  actionLabel: string,
): Promise<void> {
  const actionOwner = kind === "assistant" ? await timelineResponseFooter(row) : row;
  const actionBar = actionOwner.locator(".message-action-bar").first();
  const initial = await readMessageSurface(row);
  const transparent = "rgba(0, 0, 0, 0)";

  if (kind === "assistant") {
    expect(initial.backgroundColor).toBe(transparent);
    expect(hasVisibleBorder(initial)).toBe(false);
  } else if (kind === "user") {
    const token = await row.evaluate(element => {
      const style = getComputedStyle(element);
      const value = style.getPropertyValue("--ling-bg-subtle").trim() || style.getPropertyValue("--ling-bg-subtle").trim();
      if (!value) throw new Error("User bubble must resolve its semantic surface token");
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    });
    await expect(row.locator(":scope > .message-content")).toHaveCSS("background-color", token);
    expect(initial.backgroundColor).not.toBe(transparent);
    expect(hasVisibleBorder(initial)).toBe(false);
  } else {
    expect(initial.backgroundColor).not.toBe(transparent);
    expect(hasVisibleBorder(initial)).toBe(true);
  }

  await expect.poll(() => actionBar.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThan(0.01);
  await actionOwner.hover();
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
  readonly borderStyles: readonly string[];
  readonly borderWidths: readonly number[];
  readonly boxShadow: string;
}> {
  return row.locator(":scope > .message-content").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
      borderStyles: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle],
      borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
        .map((width) => Number.parseFloat(width)),
      boxShadow: style.boxShadow,
    };
  });
}

function hasVisibleBorder(surface: {
  readonly borderColors: readonly string[];
  readonly borderStyles: readonly string[];
  readonly borderWidths: readonly number[];
}): boolean {
  const transparent = "rgba(0, 0, 0, 0)";
  return surface.borderColors.some((color, index) =>
    color !== transparent && surface.borderStyles[index] !== "none" && (surface.borderWidths[index] ?? 0) > 0
  );
}
