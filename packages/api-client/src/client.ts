import { systemEndpoints, type SystemEndpoints } from "./endpoints/system.js";
import { automationEndpoints, type AutomationEndpoints } from "./endpoints/automation.js";
import { skillEndpoints, type SkillEndpoints } from "./endpoints/skills.js";
import { governanceNotificationEndpoints, type GovernanceNotificationEndpoints } from "./endpoints/governance-notifications.js";
import { runEndpoints, type RunEndpoints } from "./endpoints/runs.js";
import { memoryEndpoints, type MemoryEndpoints } from "./endpoints/memory.js";
import { runtimeEndpoints, type RuntimeEndpoints } from "./endpoints/runtime.js";
import { channelEndpoints, type ChannelEndpoints } from "./endpoints/channels.js";
import { teammateEndpoints, type TeammateEndpoints } from "./endpoints/teammates.js";
import { taskEndpoints, type TaskEndpoints } from "./endpoints/tasks.js";
import { adminEndpoints, type AdminEndpoints } from "./endpoints/admin.js";
import { externalWorkEndpoints, type ExternalWorkEndpoints } from "./endpoints/external-work.js";
import { operationEndpoints, type OperationEndpoints } from "./endpoints/operations.js";
import { LingDaemonTransport } from "./transport.js";

export { daemonBaseUrlFromEnv, type LingDaemonClientOptions } from "./transport.js";

export interface LingDaemonClient extends
  SystemEndpoints,
  AutomationEndpoints,
  SkillEndpoints,
  GovernanceNotificationEndpoints,
  RunEndpoints,
  MemoryEndpoints,
  RuntimeEndpoints,
  ChannelEndpoints,
  TeammateEndpoints,
  TaskEndpoints,
  AdminEndpoints,
  ExternalWorkEndpoints,
  OperationEndpoints {}

export class LingDaemonClient extends LingDaemonTransport {}

Object.assign(
  LingDaemonClient.prototype,
  systemEndpoints,
  automationEndpoints,
  skillEndpoints,
  governanceNotificationEndpoints,
  runEndpoints,
  memoryEndpoints,
  runtimeEndpoints,
  channelEndpoints,
  teammateEndpoints,
  taskEndpoints,
  adminEndpoints,
  externalWorkEndpoints,
  operationEndpoints,
);
