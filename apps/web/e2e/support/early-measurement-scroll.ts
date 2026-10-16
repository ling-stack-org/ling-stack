import type { Locator } from "@playwright/test";

/** Deliver a real scroll write before React commits the virtualizer's new geometry. */
export async function installEarlyMeasurementScroll(feed: Locator): Promise<void> {
  await feed.evaluate((element) => {
    const scrollTo = element.scrollTo.bind(element);
    element.dataset.testEarlyMeasurementScrolls = "0";
    element.scrollTo = (optionsOrX: ScrollToOptions | number, y?: number) => {
      if (typeof optionsOrX === "number") scrollTo(optionsOrX, y ?? 0);
      else scrollTo(optionsOrX);
      element.dataset.testEarlyMeasurementScrolls = String(Number(element.dataset.testEarlyMeasurementScrolls) + 1);
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    };
  });
}
