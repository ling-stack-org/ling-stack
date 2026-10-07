import { CORE_EXTERNAL_WORK_SCHEDULER_ENTRY, CORE_OFFICIAL_SKILL_GIT_ENTRY } from "@ling-stack/core";
import { defineCoreProtectedHostActorEntry } from "./protected-host-actor-inventory.js";

/** Exact original sources, installed once by the Host, never a configurable producer list. */
export const CORE_OFFICIAL_SKILL_GIT_ACTOR_ENTRY = defineCoreProtectedHostActorEntry(CORE_OFFICIAL_SKILL_GIT_ENTRY);
export const CORE_EXTERNAL_WORK_SCHEDULER_ACTOR_ENTRY = defineCoreProtectedHostActorEntry(CORE_EXTERNAL_WORK_SCHEDULER_ENTRY);
