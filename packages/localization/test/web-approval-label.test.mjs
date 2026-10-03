import assert from "node:assert/strict";
import test from "node:test";

import { formatCatalogMessage, loadCatalog } from "../dist/catalog.js";

test("packaged Chinese catalog translates the conversation approval label", async () => {
  const [chinese, english] = await Promise.all([loadCatalog("zh-CN"), loadCatalog("en-US")]);
  assert.equal(formatCatalogMessage(chinese.messages, english.messages, "Help me approve"), "帮我审批");
});
