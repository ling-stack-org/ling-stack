import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => await readFile(new URL(path, import.meta.url), "utf8");

test("unpaired launch is gated by secure QR pairing and PC confirmation", async () => {
  const [app, gate, provider] = await Promise.all([
    source("../App.tsx"),
    source("../src/features/pairing/PairingGate.tsx"),
    source("../src/remote/MobileRemoteProvider.tsx"),
  ]);
  assert.match(app, /phase === "paired"/u);
  assert.match(gate, /扫描 PC 配对码/u);
  assert.match(gate, /awaiting_pc/u);
  assert.match(provider, /RemotePairingClient/u);
  assert.match(provider, /nativeSecureDeviceKeyAdapter/u);
});

test("paired Mobile V1 exposes one index and one shared detail for all three kinds", async () => {
  const [navigator, index, detail, domain] = await Promise.all([
    source("../src/navigation/MobileConversationNavigator.tsx"),
    source("../src/features/conversations/screens/ConversationIndexScreen.tsx"),
    source("../src/features/conversations/screens/ConversationDetailScreen.tsx"),
    source("../src/features/conversations/domain/conversation-view-model.ts"),
  ]);
  assert.match(navigator, /ConversationIndexScreen/u);
  assert.match(navigator, /ConversationDetailScreen/u);
  assert.match(index, /ConversationKindFilter/u);
  assert.match(detail, /PlainTextComposer/u);
  assert.match(domain, /teammate_direct/u);
  assert.doesNotMatch(`${index}\n${detail}`, /attachment|workflow|approval|terminal|Computer Use/iu);
});

test("Mobile themes are typed app-local UI 2.0 tokens and never import Web CSS", async () => {
  const theme = await source("../src/theme/mobile-theme.ts");
  assert.match(theme, /#f6f7f8/u);
  assert.match(theme, /#111315/u);
  assert.match(theme, /Ling Light|lingLightMobileTheme/u);
  assert.doesNotMatch(theme, /apps\/web|\.css|conversation-ui-react/u);
});

test("profile surface remains narrow and unpair calls the ordered remote client cleanup", async () => {
  const [profile, provider, client] = await Promise.all([
    source("../src/features/profile/MyScreen.tsx"),
    source("../src/remote/MobileRemoteProvider.tsx"),
    source("../../../packages/remote-client/src/client.ts"),
  ]);
  assert.match(profile, /编辑个人资料/u);
  assert.match(profile, /Ling Light/u);
  assert.match(profile, /取消绑定/u);
  assert.match(provider, /client\.unpair\(\)/u);
  assert.match(client, /security\.unpair/u);
  assert.match(client, /cacheStore\.remove/u);
  assert.match(client, /keys\.delete/u);
});
