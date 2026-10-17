import { expect, type Locator } from "@playwright/test";

/** Resolve the canonical response owner without assuming actions live in the body. */
export async function timelineResponseFooter(message: Locator): Promise<Locator> {
  const responseId = await message.evaluate(element => element
    .closest<HTMLElement>('[data-conversation-focus-block][data-conversation-response-id]')
    ?.dataset.conversationResponseId);
  expect(responseId, "Message must belong to a canonical response").toBeTruthy();
  const footer = message.page().locator(`[data-conversation-response-footer][data-conversation-response-id=${JSON.stringify(responseId)}]`);
  await expect(footer).toHaveCount(1);
  return footer;
}
