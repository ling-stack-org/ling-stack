import type { SkillRegressionGuardrails } from "./skill-types.js";

export const skillRegressionGuardrails: SkillRegressionGuardrails = Object.freeze({
  authority: "shadow",
  canMutateSkillDefinition: false,
  canMutateSourceSnapshot: false,
  canMutateCompiledView: false,
  canChangeRuntimeAuthority: false,
  requiresPassingGateForAutoSafe: true,
});
