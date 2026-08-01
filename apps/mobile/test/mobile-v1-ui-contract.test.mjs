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

test("paired Mobile V1 exposes one index and one shared semantic detail for all three kinds", async () => {
  const [manifest, navigator, index, detail, domain, adapter, body] = await Promise.all([
    source("../package.json"),
    source("../src/navigation/MobileConversationNavigator.tsx"),
    source("../src/features/conversations/screens/ConversationIndexScreen.tsx"),
    source("../src/features/conversations/screens/ConversationDetailScreen.tsx"),
    source("../src/features/conversations/domain/conversation-view-model.ts"),
    source("../src/features/conversations/domain/MobileConversationAdapter.ts"),
    source("../src/features/conversations/components/NativeMessageBody.tsx"),
  ]);
  assert.match(navigator, /ConversationIndexScreen/u);
  assert.match(navigator, /ConversationDetailScreen/u);
  assert.match(index, /ConversationKindFilter/u);
  assert.match(detail, /PlainTextComposer/u);
  assert.match(detail, /adaptRemoteConversationMessages/u);
  assert.match(domain, /teammate_direct/u);
  assert.match(manifest, /@ling-stack\/conversation-ui-core/u);
  assert.match(adapter, /parseMessageBody/u);
  assert.match(body, /MessageBodyBlock/u);
  assert.doesNotMatch(`${adapter}\n${body}`, /apps\/web|conversation-ui-react|\.css/iu);
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
  const [profile, provider, client, storage] = await Promise.all([
    source("../src/features/profile/MyScreen.tsx"),
    source("../src/remote/MobileRemoteProvider.tsx"),
    source("../../../packages/remote-client/src/client.ts"),
    source("../src/platform/remote-storage.ts"),
  ]);
  assert.match(profile, />编辑</u);
  assert.match(profile, /跟随系统/u);
  assert.match(profile, /已绑定的 PC/u);
  assert.match(profile, /Ling Light/u);
  assert.match(profile, /取消绑定/u);
  assert.match(provider, /client\.unpair\(\)/u);
  assert.match(client, /security\.unpair/u);
  assert.match(client, /cacheStore\.remove/u);
  assert.match(client, /keys\.delete/u);
  assert.match(provider, /removeConversationDrafts\(workspaceBindingId\)/u);
  assert.match(provider, /nextState\.connection === "revoked"/u);
  assert.match(provider, /finishRemoteRevocation\(observedWorkspaceBindingId\)/u);
  assert.match(provider, /setPhase\("welcome"\)/u);
  assert.match(storage, /AsyncStorage\.getAllKeys\(\)/u);
  assert.match(storage, /key\.startsWith\(prefix\)/u);
  assert.match(storage, /AsyncStorage\.multiRemove\(keys\)/u);
});
