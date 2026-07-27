import type {
  AiTeammateTemplate,
  SkillApprovalProfile,
  WorkflowPhase,
} from "@ling-stack/core/skill-types";
import type { Translate } from "../../i18n.js";
import type { AvatarTone } from "../../shared/components/index.js";
import type { TeammateTemplateFilter } from "./types.js";

export function teammateInitial(template: AiTeammateTemplate): string {
  const firstLetter = template.name.trim().charAt(0).toUpperCase();
  return firstLetter || "AI";
}

export function teammateInitialFromName(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) {
    return "AI";
  }
  if (!/^[\x00-\x7F]+$/u.test(cleaned)) {
    return Array.from(cleaned)[0]?.toUpperCase() || "AI";
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export function teammateTemplateMatchesFilter(template: AiTeammateTemplate, filter: TeammateTemplateFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "engineering") {
    return template.roleKey === "architect" || template.roleKey === "engineer" || template.roleKey === "release";
  }
  if (filter === "design") {
    return template.roleKey === "designer";
  }
  return template.roleKey === filter;
}

export function roleAvatarTone(roleKey: AiTeammateTemplate["roleKey"]): AvatarTone {
  if (roleKey === "product" || roleKey === "release") {
    return "orange";
  }
  if (roleKey === "engineer" || roleKey === "architect") {
    return "teal";
  }
  if (roleKey === "designer" || roleKey === "docs") {
    return "violet";
  }
  if (roleKey === "qa") {
    return "blue";
  }
  if (roleKey === "security") {
    return "rose";
  }
  return "default";
}

export function roleLabel(roleKey: AiTeammateTemplate["roleKey"], t: Translate): string {
  return t(`role.${roleKey}`);
}

export function workflowPhaseLabel(phase: WorkflowPhase, t: Translate): string {
  return t(`phase.${phase}`);
}

export function approvalProfileText(profile: SkillApprovalProfile, t: Translate): string {
  if (profile.mode === "none") {
    return t("No extra approval");
  }
  const risk = profile.risk ? t(`risk.${profile.risk}`) : "";
  if (profile.mode === "standard") {
    return profile.risk ? t("Standard · {risk}", { risk }) : t("Standard");
  }
  return profile.risk ? t("Strict · {risk}", { risk }) : t("Strict");
}
