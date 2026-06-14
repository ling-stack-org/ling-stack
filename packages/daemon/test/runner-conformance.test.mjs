import {
  FakeConformantRunner,
  FakeExternalAgentRunner,
  runRunnerConformanceSuite,
} from "../dist/runtime/runner-conformance.js";

runRunnerConformanceSuite("fake-conformant-runner", (options) => new FakeConformantRunner(options));
runRunnerConformanceSuite("fake-external-agent-runner", (options) => new FakeExternalAgentRunner(options));
