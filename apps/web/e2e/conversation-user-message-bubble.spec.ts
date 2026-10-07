import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "@ling-stack/conversation-ui-react";

const surfaces = ["normal_conversation", "teammate_direct", "channel_root"] as const;
const richBody = [
  "First paragraph.\nKeep this explicit line break.",
  "> Quoted context stays inside the user bubble.",
  "```ts\nconst answer = 42;\nconsole.log(answer);\n```",
  `Long reference: https://example.test/${"workspace-reference-".repeat(24)}`,
  `Long identifier: ${"unbroken_reference_".repeat(24)}`,
  "| File | Result |\n| --- | --- |\n| README.md | Reviewed |",
].join("\n\n");

for (const theme of ["light", "dark"]) {
  for (const width of [390, 960]) {
    test.describe(`${theme} ${width}px shared user bubble`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("short and rich user bodies stay bounded; Agent remains unboxed", async ({ page }, testInfo) => {
        const markup = renderToStaticMarkup(createElement("main", {
          style: { padding: 16, maxWidth: 800, margin: "0 auto" },
        }, surfaces.flatMap((surface) => [
          createElement(MessageRow, {
            key: `${surface}-short`, id: `${surface}-short`, surface, tone: "document",
            authorType: "local-user", authorName: "You", body: "A short question.",
          }),
          createElement(MessageRow, {
            key: `${surface}-rich`, id: `${surface}-rich`, surface, tone: "document",
            authorType: "local-user", authorName: "You", body: richBody,
            avatar: createElement("span", { className: "avatar-initial" }, "U"),
            // Exercise the shared attachment slot without inventing file evidence.
            attachmentsNode: createElement("button", { type: "button" }, "Attached reference"),
            actionsNode: createElement("button", { type: "button" }, "Copy message"),
          }),
          createElement(MessageRow, {
            key: `${surface}-agent`, id: `${surface}-agent`, surface, tone: "document",
            authorType: "ai-teammate", authorName: "Engineer", body: "Agent narration stays unboxed.",
          }),
        ])));
        await page.route("**/__user-bubble-fixture", (route) => route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="en" data-theme="${theme}" data-ui-theme="ling-${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles.css"></head><body>${markup}</body></html>`,
        }));
        await page.goto("/__user-bubble-fixture");
        const backgrounds = new Set<string>();
        for (const surface of surfaces) {
          const short = page.locator(`#${surface}-short > .message-content`);
          const row = page.locator(`#${surface}-rich`);
          const content = row.locator(":scope > .message-content");
          await expect(content.locator(".message-code-block")).toHaveCount(1);
          await expect(content.locator(".message-code-block code")).toHaveText("const answer = 42;\nconsole.log(answer);");
          await expect(content.locator(".message-body-quote")).toContainText("Quoted context");
          await expect(content.locator(".message-body-table")).toContainText("README.md");
          await expect(content.getByRole("button", { name: "Attached reference" })).toBeVisible();
          const geometry = await row.evaluate((element) => {
            const body = element.querySelector<HTMLElement>(":scope > .message-content")!;
            const actions = element.querySelector<HTMLElement>(":scope > .message-row-own-actions")!;
            const rect = body.getBoundingClientRect();
            return {
              background: getComputedStyle(body).backgroundColor,
              radius: Number.parseFloat(getComputedStyle(body).borderTopLeftRadius),
              bodyRight: rect.right, rowRight: element.getBoundingClientRect().right,
              bodyBottom: rect.bottom, actionsTop: actions.getBoundingClientRect().top,
              bodyWidth: rect.width, rowWidth: element.getBoundingClientRect().width,
              width: body.clientWidth, scrollWidth: body.scrollWidth,
            };
          });
          backgrounds.add(geometry.background);
          expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
          expect(geometry.radius).toBeGreaterThan(0);
          expect(geometry.bodyRight).toBeLessThanOrEqual(geometry.rowRight + 1);
          expect(geometry.bodyWidth).toBeLessThan(geometry.rowWidth);
          expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
          expect(geometry.actionsTop).toBeGreaterThanOrEqual(geometry.bodyBottom);
          expect((await short.boundingBox())!.width).toBeLessThan(geometry.bodyWidth);
          await expect(page.locator(`#${surface}-agent > .message-content`)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await row.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`${surface}-${theme}-${width}.png`) });
        }
        expect(backgrounds.size).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      });
    });
  }
}
