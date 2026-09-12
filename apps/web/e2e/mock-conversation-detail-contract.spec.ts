import { expect, test } from "@playwright/test";
import type { ConversationDetailResponse } from "@ling-stack/contracts";
import { mergeConversationDetailSnapshots } from "../src/domains/conversations/conversation-detail-merge";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { buildMockConversationDetail } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";

test("mock conversation detail keeps required collections iterable across refreshes", () => {
  const state = createBaseState({ approvalStatus: "expired" });
  installNormalWorkCellFixture(state);
  const thread = state.threads.find((candidate) => candidate.kind === "conversation");
  expect(thread).toBeDefined();

  const detail = buildMockConversationDetail(state, cwd, thread!) as unknown as ConversationDetailResponse;
  const requiredCollections = [
    "turns",
    "conversationItems",
    "userInputs",
    "runLinks",
    "runs",
    "reasoningSummaries",
    "executionActions",
    "approvals",
    "approvalCheckpoints",
    "interventions",
    "terminalReports",
    "artifacts",
    "messages",
    "generatedMedia",
  ] as const satisfies readonly (keyof ConversationDetailResponse)[];

  for (const key of requiredCollections) {
    expect(Array.isArray(detail[key]), `${key} must be an array`).toBe(true);
  }

  const hydrated = mergeConversationDetailSnapshots(undefined, detail);
  expect(() => mergeConversationDetailSnapshots(hydrated, detail)).not.toThrow();
});
