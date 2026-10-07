import assert from "node:assert/strict";
import test from "node:test";
import { coordinateChannelExecutionProposalConfirmation } from "../src/app/channel-execution-proposal-confirmation.ts";

test("failed confirmation preserves the server error and refreshes authoritative proposal state", async () => {
  const calls = [];
  const failure = new Error("workspace_default_provider_missing");

  await coordinateChannelExecutionProposalConfirmation(coordinatorInput({
    confirm: async () => {
      calls.push("confirm");
      throw failure;
    },
    publishConfirmed: () => calls.push("publish"),
    refreshAfterConfirmationFailure: async () => calls.push("refresh-proposal"),
    reportConfirmationError: (message) => calls.push(["confirmation-error", message]),
  }));

  assert.deepEqual(calls, [
    "confirm",
    ["confirmation-error", failure.message],
    "refresh-proposal",
  ]);
});

test("failed recovery refresh does not replace or throw past the original confirmation error", async () => {
  const calls = [];

  await coordinateChannelExecutionProposalConfirmation(coordinatorInput({
    confirm: async () => {
      throw new Error("workspace_default_provider_missing");
    },
    refreshAfterConfirmationFailure: async () => {
      calls.push("refresh-proposal");
      throw new Error("proposal_refresh_unavailable");
    },
    reportConfirmationError: (message) => calls.push(["confirmation-error", message]),
    reportRefreshError: (stage, message) => calls.push(["refresh-error", stage, message]),
  }));

  assert.deepEqual(calls, [
    ["confirmation-error", "workspace_default_provider_missing"],
    "refresh-proposal",
    ["refresh-error", "after-confirmation-failure", "proposal_refresh_unavailable"],
  ]);
});

test("successful confirmation publishes canonical state before refreshing dependent views", async () => {
  const calls = [];
  const response = { proposal: { id: "proposal_1", revision: 2 } };

  await coordinateChannelExecutionProposalConfirmation(coordinatorInput({
    confirm: async (cwd, proposalId) => {
      calls.push(["confirm", cwd, proposalId]);
      return response;
    },
    publishConfirmed: (confirmed) => calls.push(["publish", confirmed.proposal.revision]),
    refreshAfterConfirmation: async () => calls.push("refresh-dependent-views"),
  }));

  assert.deepEqual(calls, [
    ["confirm", "/workspace", "proposal_1"],
    ["publish", 2],
    "refresh-dependent-views",
  ]);
});

test("post-confirmation refresh failure is not misreported as a confirmation failure", async () => {
  const calls = [];

  await coordinateChannelExecutionProposalConfirmation(coordinatorInput({
    confirm: async () => ({ proposal: { id: "proposal_1", revision: 2 } }),
    publishConfirmed: () => calls.push("publish"),
    refreshAfterConfirmation: async () => {
      calls.push("refresh-dependent-views");
      throw new Error("runs_refresh_unavailable");
    },
    reportConfirmationError: (message) => calls.push(["confirmation-error", message]),
    reportRefreshError: (stage, message) => calls.push(["refresh-error", stage, message]),
  }));

  assert.deepEqual(calls, [
    "publish",
    "refresh-dependent-views",
    ["refresh-error", "after-confirmation", "runs_refresh_unavailable"],
  ]);
});

function coordinatorInput(overrides = {}) {
  return {
    proposal: { id: "proposal_1", channelId: "channel_1" },
    workspaceCwd: "/workspace",
    confirm: async () => ({ proposal: { id: "proposal_1", revision: 2 } }),
    publishConfirmed: () => {},
    refreshAfterConfirmation: async () => {},
    refreshAfterConfirmationFailure: async () => {},
    reportConfirmationError: () => {},
    reportRefreshError: () => {},
    ...overrides,
  };
}
