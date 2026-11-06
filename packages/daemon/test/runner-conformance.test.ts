import {
  FakeConformantRunner,
  FakeExternalAgentRunner,
  runRunnerConformanceSuite,
} from "./test-support/runner-conformance.ts";

runRunnerConformanceSuite("fake-conformant-runner", (options) => new FakeConformantRunner(options));
runRunnerConformanceSuite("fake-external-agent-runner", (options) => new FakeExternalAgentRunner(options));
