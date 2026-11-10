import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

async function fixture(t, request) {
  const port = catalogHookPort();
  const calls = [];
  const h = await catalogConsumerHarness(t, {
    exports: { "domains/workspace/use-workspace-domain.ts": ["useWorkspaceDomain"],
      "features/workspace/ChannelFeedChrome.tsx": ["ChannelFeedStatus"] },
    ports: { hooks: port.hooks, listStateTransitions: (...args) => { calls.push(args); return request(...args); } },
    transforms: {
      "domains/workspace/use-workspace-domain.ts": [
        { anchor: 'import { useRef, useState, type Dispatch, type SetStateAction } from "react";',
          replace: key => `const { useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
        { anchor: "  listStateTransitions,\n", replace: () => "" },
        { anchor: '} from "../../api.js";', replace: key => `} from "../../api.js";\nconst listStateTransitions = (...args) => globalThis[${JSON.stringify(key)}].ports.listStateTransitions(...args);` },
      ],
      "lib/use-latest-request.ts": [{ anchor: 'import { useRef } from "react";',
        replace: key => `const { useRef } = globalThis[${JSON.stringify(key)}].ports.hooks;` }],
    },
  });
  const translate = await h.select("so-SO");
  const input = { cwd: "/isolated/c012", initialWorkspaceCwd: "/isolated/c012", selectedChannelBranchId: "", translate,
    reportFeedback: () => {}, clearFeedback: () => {} };
  const render = () => port.render(h.module.useWorkspaceDomain, input);
  const renderFeed = controller => h.render(h.module.ChannelFeedStatus, {
    loading: controller.state.channelActivityTransitionsLoading,
    error: Boolean(controller.state.channelActivityTransitionError),
  });
  let controller = render();
  controller.actions.setSelectedChannelId("qa-channel");
  controller.actions.setTasks([{ id: "qa-task", channelId: "qa-channel", updatedAt: "2026-10-17T00:00:00.000Z" }]);
  controller = render();
  return { h, calls, render, renderFeed, controller };
}

test("C012 so-SO actual listStateTransitions rejection→domain state→feed warning preserves failure meaning", async t => {
  let reject;
  const f = await fixture(t, () => new Promise((_, fail) => { reject = fail; }));
  const pending = f.controller.actions.refreshChannelActivityTransitions();
  let controller = f.render();
  assert.equal(controller.state.channelActivityTransitionsLoading, true);
  assert.equal(controller.state.channelActivityTransitionError, "");
  f.renderFeed(controller);
  assert.equal(f.h.state.calls.some(call => call.key === "Some activity changes could not be loaded"), false);
  reject(new Error("Synthetic transition request failed"));
  await pending;
  controller = f.render();
  assert.equal(controller.state.channelActivityTransitionsLoading, false);
  assert.equal(controller.state.channelActivityTransitionError, "Synthetic transition request failed");
  assert.deepEqual(controller.state.channelStateTransitions, []);
  assert.deepEqual(f.calls, [["/isolated/c012", { entityType: "task", entityId: "qa-task", limit: 20 }]]);
  const markup = f.renderFeed(controller);
  const text = f.h.state.calls.filter(call => call.key === "Some activity changes could not be loaded").at(-1)?.text;
  assert.ok(text && markup.includes(text));
  assert.match(text, /(?:lama|ma[^.!?]{0,35}(?:kari|suurtagal))/iu);
  assert.doesNotMatch(text, /waa la rari karaa/iu);
});

test("C012 actual request revision fences stale transition errors after a newer successful response", async t => {
  const pending = [];
  const f = await fixture(t, () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const stale = f.controller.actions.refreshChannelActivityTransitions();
  const current = f.controller.actions.refreshChannelActivityTransitions();
  pending[1].resolve({ transitions: [{ id: "latest", createdAt: "2026-10-17T00:00:00.000Z" }] });
  await current;
  pending[0].reject(new Error("stale synthetic failure"));
  await stale;
  const controller = f.render();
  assert.equal(controller.state.channelActivityTransitionError, "");
  assert.equal(controller.state.channelActivityTransitionsLoading, false);
  assert.deepEqual(controller.state.channelStateTransitions.map(value => value.id), ["latest"]);
  f.h.state.calls.length = 0;
  assert.equal(f.renderFeed(controller), "");
  assert.equal(f.h.state.calls.some(call => call.key === "Some activity changes could not be loaded"), false);
});

test("C012 actual empty scope clears state without scheduling any transition requests", async t => {
  const f = await fixture(t, async () => { throw new Error("must not request an empty scope"); });
  await f.controller.actions.refreshChannelActivityTransitions("", "");
  const controller = f.render();
  assert.equal(controller.state.channelActivityTransitionError, "");
  assert.equal(controller.state.channelActivityTransitionsLoading, false);
  assert.deepEqual(controller.state.channelStateTransitions, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.renderFeed(controller), "");
});
