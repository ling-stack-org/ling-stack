import { expect, type Locator } from "@playwright/test";

export async function expectMessageFrameContained(row: Locator): Promise<void> {
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();

  const geometry = await row.evaluate((element) => {
    const root = element as HTMLElement;
    const tolerance = 2;
    const violations: string[] = [];
    const containsHorizontally = (owner: DOMRect, child: DOMRect): boolean =>
      child.left >= owner.left - tolerance && child.right <= owner.right + tolerance;
    const record = (label: string, owner: HTMLElement, child: HTMLElement): void => {
      if (!containsHorizontally(owner.getBoundingClientRect(), child.getBoundingClientRect())) {
        violations.push(label);
      }
    };

    const group = root.closest<HTMLElement>(".message-group, .message-feed-virtual-row");
    if (group && group !== root) {
      record("bubble outside message group", group, root);
    }

    const content = root.querySelector<HTMLElement>(":scope > .message-content");
    if (!content) {
      return { contentFound: false, rootOverflow: root.scrollWidth - root.clientWidth, violations };
    }
    record("message content outside bubble", root, content);

    for (const node of content.querySelectorAll<HTMLElement>(".message-meta, .message-meta-action, .message-action")) {
      record(`${node.className} outside message content`, content, node);
    }
    for (const node of root.querySelectorAll<HTMLElement>(":scope > .message-row-own-actions")) {
      record("own-message actions outside bubble", root, node);
    }

    return {
      contentFound: true,
      rootOverflow: root.scrollWidth - root.clientWidth,
      violations,
    };
  });

  expect(geometry.contentFound).toBe(true);
  expect(geometry.rootOverflow).toBeLessThanOrEqual(1);
  expect(geometry.violations).toEqual([]);
}
