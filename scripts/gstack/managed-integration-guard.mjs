import { requireResourceLease } from "./resource-workspace.mjs";

const actualInputKeys = ["SOURCE", "PREVIOUS_SOURCE", "SOURCE_CANDIDATE", "NATIVE_CANDIDATE", "UNPATCHED_CANDIDATE",
  "PLATFORM_RESOURCE_STAGE", "RESOURCE_STAGE", "BROWSER_ARCHIVES", "BROWSER_MEMBER_INSPECTION",
  "CHROMIUM_SNAPSHOT", "CHROMIUM_CREDITS", "UNGOOGLED_CANDIDATE", "UNGOOGLED_INSPECTION", "EXECUTABLE_BUNDLE"];

// Raw node --test with real multi-GiB inputs must not silently use system temp.
if (actualInputKeys.some(key => process.env[`LING_GSTACK_${key}`])) await requireResourceLease();
