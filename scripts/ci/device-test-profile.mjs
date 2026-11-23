export const deviceTestPackages = [
  "@ling-stack/contracts", "@ling-stack/core", "@ling-stack/daemon", "@ling-stack/mobile",
  "@ling-stack/remote-client", "@ling-stack/remote-protocol",
];

export const deviceSuiteFiles = {
  core: [
    "test/device-developer.test.ts",
    "test/device-fabric-store.test.ts",
    "test/device-fabric.test.ts",
    "test/device-orchestration.test.ts",
    "test/device-protocol.test.ts",
    "test/device-semantic-capabilities.test.ts",
    "test/device-support.test.ts",
  ],
  "daemon-linux": [
    "test/device-access-grants.test.ts",
    "test/device-developer-routes.test.ts",
    "test/device-remote-facade.test.ts",
    "test/device-support-adapters.test.ts",
    "test/device-support-runtime.test.ts",
    "test/home-assistant-catalog.test.ts",
    "test/linux-ssh-executor.test.ts",
    "test/linux-ssh-runtime.test.ts",
    "test/modbus-serial-targets.test.ts",
  ],
};

const sharedSources = new Set([
  "packages/contracts/src/device-fabric.ts",
  "packages/contracts/src/device.ts",
  "packages/core/src/device-task-trace.ts",
]);

const devicePaths = new Set([
  ...sharedSources,
  "apps/mobile/src/device/execution.ts",
  "apps/mobile/src/device/home-assistant.ts",
  "apps/mobile/src/device/journal.ts",
  "apps/mobile/src/device/standalone-runtime.ts",
  "apps/mobile/src/device/trace.ts",
  "apps/mobile/src/features/device-tasks/StandaloneDeviceScreen.tsx",
  "apps/mobile/test/standalone-device-runtime.test.ts",
  "packages/contracts/test/device.test.ts",
  ...deviceSuiteFiles.core.map(file => `packages/core/${file}`),
  ...deviceSuiteFiles["daemon-linux"].map(file => `packages/daemon/${file}`),
]);

export function matchesDeviceTestProfile(files) {
  return files.some(file => sharedSources.has(file)) && files.every(file => devicePaths.has(file));
}
