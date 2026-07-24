import type { AiTeammate } from "../../types.js";

const AVATAR_BASE_PATH = `${import.meta.env.BASE_URL}avatars/teammates`;

const templateAvatarById: Readonly<Record<string, string>> = {
  ling_agent: "ling-agent.png",
  "product-strategist": "product-strategist.png",
  architect: "architect.png",
  engineer: "engineer.png",
  designer: "designer.png",
  qa: "qa.png",
  security: "security.png",
  release: "release.png",
  docs: "docs.png",
};

const roleAvatarByKey: Readonly<Record<AiTeammate["roleKey"], string>> = {
  product: "product-strategist.png",
  architect: "architect.png",
  engineer: "engineer.png",
  designer: "designer.png",
  qa: "qa.png",
  security: "security.png",
  release: "release.png",
  docs: "docs.png",
  custom: "custom.png",
};

export interface DefaultTeammateAvatarLike {
  readonly templateId?: string;
  readonly roleKey?: AiTeammate["roleKey"];
  readonly kind?: AiTeammate["kind"];
  readonly systemRole?: AiTeammate["systemRole"];
}

export function defaultTeammateAvatarSrc(teammate: DefaultTeammateAvatarLike): string {
  if (teammate.systemRole === "ling_agent") {
    return avatarPath("ling-agent.png");
  }
  if (teammate.templateId) {
    const templateAvatar = templateAvatarById[teammate.templateId];
    if (templateAvatar) {
      return avatarPath(templateAvatar);
    }
  }
  if (teammate.roleKey) {
    return avatarPath(roleAvatarByKey[teammate.roleKey] ?? "custom.png");
  }
  return avatarPath("custom.png");
}

function avatarPath(fileName: string): string {
  return `${AVATAR_BASE_PATH}/${fileName}`;
}
