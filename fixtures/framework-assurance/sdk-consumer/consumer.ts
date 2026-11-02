import { readFile } from "node:fs/promises";
import {
  createLingExtensionRegistry,
  validateLingExtensionManifest,
  validateLingPluginPackageManifest,
  type LingExtensionManifest,
  type LingPluginPackageManifest,
  type RunnerExtensionMetadata,
} from "@ling-stack/plugin-sdk";
import {
  isRunEventType,
  isConversationContinuityGoldenFixtureV1,
  type ConversationStreamRequest,
  type CreateChannelTurnRequest,
} from "@ling-stack/contracts";
import { LingDaemonClient, LingDaemonError, LingDaemonTransportError } from "@ling-stack/api-client";
import type { SupportedLocale } from "@ling-stack/localization";
import continuity from "@ling-stack/contracts/fixtures/channel-conversation-continuity-v2.json" with { type: "json" };

const manifest: LingExtensionManifest<"runner"> = {
  id: "runner:consumer", name: "Consumer", version: "0.1.0", kind: "runner",
  trustLevel: "internal", capabilities: ["read"],
};
const runner: RunnerExtensionMetadata = {
  manifest, runnerId: "consumer", supportedTools: ["read"], supportedProviderApis: ["openai-completions"],
  eventTypes: ["run_start"], resumeCapabilities: { nativeResume: false, hostApprovalContinuation: [] },
};
validateLingExtensionManifest(manifest, "runner");
const registry = createLingExtensionRegistry();
registry.runners.register(runner);
const packageManifest: LingPluginPackageManifest = {
  id: "bundled:consumer", displayName: "Consumer", version: "0.1.0", lingInterfaceVersion: "1",
  sourceKind: "bundled", trustLevel: "internal", trustSummary: "Metadata only",
  contributions: [{ kind: "runner", id: "runner:consumer", path: "./runner.json" }],
};
validateLingPluginPackageManifest(packageManifest);

const fetchMock: typeof fetch = async () => Response.json({ fixture: true });
const client = new LingDaemonClient({ baseUrl: "https://daemon.invalid", fetch: fetchMock });
const conversation: ConversationStreamRequest = { schemaVersion: 2, message: "fixture" };
const turn: CreateChannelTurnRequest = { body: "fixture", requestAiReply: false };
const rawConversation: Promise<Response> = client.streamConversation("/fixture", conversation);
const rawChannel: Promise<Response> = client.streamChannelTurn("/fixture", "channel", turn);
const rawComputerUse: Promise<Response> = client.streamComputerUsePreviews("/fixture", 2, new AbortController().signal);
const locale: SupportedLocale = "en-US";
const unknownValue: unknown = continuity;
const guard: boolean = isConversationContinuityGoldenFixtureV1(unknownValue) && isRunEventType("run_start");
const publicErrors: readonly Error[] = [new LingDaemonError("fixture", 409, "Conflict"), new LingDaemonTransportError("fetch", new Error("fixture"))];
void [readFile, registry, rawConversation, rawChannel, rawComputerUse, locale, guard, publicErrors];
