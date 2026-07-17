import assert from "node:assert/strict";
import test from "node:test";

import { AsyncSingleFlight } from "../dist/main/async-single-flight.js";

test("delayed Desktop startup shares one in-flight main-window open", async () => {
  let calls = 0;
  let resolveStart;
  const gate = new Promise((resolve) => { resolveStart = resolve; });
  const flight = new AsyncSingleFlight();
  const operation = async () => {
    calls += 1;
    await gate;
    return true;
  };

  const first = flight.run(operation);
  const second = flight.run(operation);
  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveStart();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);

  const third = flight.run(async () => {
    calls += 1;
    return false;
  });
  assert.equal(await third, false);
  assert.equal(calls, 2);
});
