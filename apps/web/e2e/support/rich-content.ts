import { expect, type Locator } from "@playwright/test";

export const sharedConversationRichBody = [
  "## Shared conversation rendering",
  "",
  "> One renderer should preserve the same semantics on every conversation surface.",
  "",
  "| Block | State |",
  "| :--- | ---: |",
  "| GFM | Ready |",
  "| Mermaid | Ready |",
  "",
  "- [x] Shared parser",
  "- [ ] Structured previews",
  "",
  "Inline math: $a^2 + b^2 = c^2$.",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "```mermaid",
  "flowchart LR",
  "  Prompt --> Execute",
  "  Execute --> Verify",
  "```",
].join("\n");

export async function expectSharedConversationRichBody(container: Locator): Promise<void> {
  await expect(container.getByRole("heading", { name: "Shared conversation rendering", level: 2 })).toBeVisible();
  await expect(container.locator(".message-body-quote")).toContainText("same semantics");
  await expect(container.locator(".message-body-table")).toContainText("Mermaid");
  await expect(container.locator(".message-body-task-item input[type=checkbox]")).toHaveCount(2);
  await expect(container.locator(".message-inline-math .katex")).toBeVisible();
  await expect(container.locator(".message-math-block .katex-display")).toBeVisible();
  const mermaidBlock = container.locator(".message-mermaid-block");
  await mermaidBlock.scrollIntoViewIfNeeded();
  await expect(mermaidBlock.locator(".message-mermaid-canvas svg")).toBeVisible();
}
