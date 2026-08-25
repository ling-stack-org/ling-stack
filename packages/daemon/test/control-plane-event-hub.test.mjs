import assert from "node:assert/strict";
import test from "node:test";
import { coalesceAndSortControlPlaneEvents } from "../dist/features/control-plane/event-queue.js";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";

test("control-plane stream registers before replay and orders a concurrent live event by sequence", () => {
  const chunks = [];
  const response = {
    writableEnded: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  const hub = new ControlPlaneEventHub();
  const replay = event(1, "provider_replay");
  const live = event(2, "provider_live");
  const subscription = hub.subscribe({
    workspaceId: "workspace_default",
    cwd: "/workspace",
    domains: ["providers"],
    response,
    latestEventSeq: () => 2,
    replayWindow: () => {
      hub.publish(live);
      return {
        window: completeWindow(0, 1),
        events: [replay],
      };
    },
  });
  try {
    const observed = chunks
      .join("")
      .split("\n\n")
      .filter((block) => block.includes("event: control_plane_event"))
      .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
    assert.deepEqual(observed.map((item) => item.seq), [1, 2]);
    assert.deepEqual(observed.map((item) => item.entityId), ["provider_replay", "provider_live"]);
  } finally {
    subscription.close();
    hub.closeAll();
  }
});

test("control-plane stream removes its provisional client when replay lookup fails", () => {
  const chunks = [];
  const response = {
    writableEnded: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  const hub = new ControlPlaneEventHub();
  assert.throws(() => hub.subscribe({
    workspaceId: "workspace_default",
    cwd: "/workspace",
    domains: ["providers"],
    response,
    latestEventSeq: () => 2,
    replayWindow: () => {
      throw new Error("replay unavailable");
    },
  }), /replay unavailable/u);

  assert.equal(response.writableEnded, true);
  hub.publish(event(2, "provider_after_failure"));
  assert.equal(chunks.length, 0);
  hub.closeAll();
});

test("control-plane stream sends snapshot-required and removes its provisional client", () => {
  const chunks = [];
  const response = fakeResponse(chunks);
  const hub = new ControlPlaneEventHub();
  hub.subscribe({
    workspaceId: "workspace_default",
    cwd: "/workspace",
    domains: ["providers"],
    response,
    latestEventSeq: () => 1,
    replayWindow: () => ({
      window: {
        ...completeWindow(9, 1),
        disposition: "snapshot_required",
        reason: "cursor_unavailable",
      },
      events: [],
    }),
  });
  assert.equal(response.writableEnded, true);
  const blocks = chunks.join("").split("\n\n");
  assert.equal(blocks.some((block) => block.includes("event: control_plane_snapshot_required")), true);
  const before = chunks.length;
  hub.publish(event(2, "provider_after_snapshot"));
  assert.equal(chunks.length, before);
  hub.closeAll();
});

test("control-plane listener buffers until activation and orders replay before live", () => {
  const delivered = [];
  const hub = new ControlPlaneEventHub();
  const listener = hub.subscribeListener({
    workspaceId: "workspace_default",
    cwd: "/workspace",
    domains: ["providers"],
    onEvent: (value) => delivered.push(value.seq),
  });
  hub.publish(event(2, "provider_live"));
  assert.deepEqual(delivered, []);
  listener.activate([event(1, "provider_replay")]);
  assert.deepEqual(delivered, [1, 2]);
  listener.close();
  hub.closeAll();
});

test("control-plane queue coalescing preserves global durable sequence order", () => {
  const events = Array.from({ length: 399 }, (_, index) => event(index + 1, "provider_repeated"));
  events.push({
    ...event(400, "run_terminal"),
    domain: "runs",
    entityType: "run",
    action: "run.completed",
  });
  const coalesced = coalesceAndSortControlPlaneEvents(events);
  assert.deepEqual(coalesced.map((item) => item.seq), [399, 400]);
  assert.equal(coalesced[0].data.count, 399);
  assert.equal(coalesced[0].data.summary, "coalesced control-plane invalidations");
  assert.equal(coalesced[1].action, "run.completed");
  assert.equal(coalesced.every((item, index) => index === 0 || coalesced[index - 1].seq < item.seq), true);
});

function completeWindow(requestedAfterSeq, upperBoundSeq) {
  return {
    disposition: "complete",
    requestedAfterSeq,
    replayFloorSeq: 0,
    upperBoundSeq,
    nextAfterSeq: upperBoundSeq,
  };
}

function fakeResponse(chunks) {
  return {
    writableEnded: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
}

function event(seq, entityId) {
  return {
    seq,
    workspaceId: "workspace_default",
    cwd: "/workspace",
    ts: `2026-06-06T00:00:0${seq}.000Z`,
    domain: "providers",
    entityType: "provider",
    entityId,
    action: "provider.updated",
    data: { providerId: entityId },
  };
}
