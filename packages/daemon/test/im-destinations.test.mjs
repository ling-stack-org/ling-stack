import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDingtalkPayload,
  buildFeishuPayload,
  buildImPayload,
  buildSlackPayload,
  buildWecomPayload,
  isAllowedImWebhookUrl,
} from "@ling-stack/contracts";
import { ImDestinationRegistry } from "../dist/features/im-destinations/registry.js";

test("each provider builds its documented webhook payload shape", () => {
  const message = { title: "Run failed", bodyMarkdown: "daily brief failed", severity: "danger", link: "http://127.0.0.1:17891/runs/r1" };

  const feishu = JSON.parse(buildFeishuPayload(message).body);
  assert.equal(feishu.msg_type, "interactive");
  assert.equal(feishu.card.header.template, "red");
  assert.equal(feishu.card.elements[0].text.tag, "lark_md");

  const wecom = JSON.parse(buildWecomPayload(message).body);
  assert.equal(wecom.msgtype, "markdown");
  assert.ok(wecom.markdown.content.includes("daily brief failed"));

  const dingtalk = JSON.parse(buildDingtalkPayload(message).body);
  assert.equal(dingtalk.msgtype, "actionCard");
  assert.equal(dingtalk.actionCard.title, "Run failed");

  const slack = JSON.parse(buildSlackPayload(message).body);
  assert.equal(slack.attachments[0].color, "#dc2626");
  assert.equal(buildImPayload("slack", message).contentType, "application/json");
});

test("webhook URLs are egress-pinned to provider hosts over https", () => {
  assert.equal(isAllowedImWebhookUrl("feishu", "https://open.feishu.cn/open-apis/bot/v2/hook/x"), true);
  assert.equal(isAllowedImWebhookUrl("wecom", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x"), true);
  assert.equal(isAllowedImWebhookUrl("dingtalk", "https://oapi.dingtalk.com/robot/send?access_token=x"), true);
  assert.equal(isAllowedImWebhookUrl("slack", "https://hooks.slack.com/services/T/B/X"), true);
  assert.equal(isAllowedImWebhookUrl("feishu", "http://open.feishu.cn/hook"), false, "https required");
  assert.equal(isAllowedImWebhookUrl("slack", "https://evil.example.com/hook"), false);
  assert.equal(isAllowedImWebhookUrl("wecom", "not a url"), false);
});

test("registry stores refs only, dispatches through pinned URLs and records failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ling-im-"));
  const requests = [];
  const registry = new ImDestinationRegistry({
    storePath: join(dir, "im-destinations.json"),
    secretResolver: {
      status: () => "configured",
      resolve: (ref) => ({
        configured: true,
        value: ref === "env:WECOOK" ? "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" : undefined,
      }),
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
  });
  try {
    await assert.rejects(
      registry.create({ label: "raw", provider: "wecom", webhookRef: "https://qyapi.weixin.qq.com/x" }),
      /env:NAME or keychain:NAME/u,
    );
    const destination = await registry.create({ label: "WeCom bot", provider: "wecom", webhookRef: "env:WECOOK" });
    assert.equal(destination.id.startsWith("im_"), true);

    const persisted = JSON.parse(await readFile(join(dir, "im-destinations.json"), "utf8"));
    assert.equal(JSON.stringify(persisted).includes("qyapi.weixin.qq.com"), false, "raw webhook URL is never stored");

    const result = await registry.dispatch(destination, { title: "t", bodyMarkdown: "b", severity: "info" });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.startsWith("https://qyapi.weixin.qq.com/"), true);

    const missing = await registry.dispatch(
      { ...destination, webhookRef: "env:MISSING" },
      { title: "t", bodyMarkdown: "b", severity: "info" },
    );
    assert.equal(missing.ok, false);
    assert.ok(missing.error);

    const removed = await registry.remove(destination.id);
    assert.equal(removed, true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
