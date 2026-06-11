import { attachmentContentUrlById } from "../../api.js";
import { AvatarInitial, type AvatarTone } from "../../shared/components/index.js";
import type { AiTeammate } from "../../types.js";
import { roleAvatarTone, teammateInitialFromName } from "./helpers.js";

export interface TeammateAvatarLike {
  readonly displayName: string;
  readonly roleKey?: AiTeammate["roleKey"];
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
}

export function TeammateAvatarView({
  teammate,
  cwd,
  compact = false,
}: {
  readonly teammate: TeammateAvatarLike;
  readonly cwd: string;
  readonly compact?: boolean;
}): JSX.Element {
  if (teammate.avatarImageAttachmentId) {
    return (
      <img
        className={`teammate-avatar-image ${compact ? "compact" : ""}`}
        src={attachmentContentUrlById(teammate.avatarImageAttachmentId, cwd.trim())}
        alt=""
      />
    );
  }
  return <AvatarInitial label={teammateInitialFromName(teammate.displayName)} tone={teammateAvatarTone(teammate)} />;
}

function teammateAvatarTone(teammate: TeammateAvatarLike): AvatarTone {
  if (
    teammate.avatarTone === "default" ||
    teammate.avatarTone === "orange" ||
    teammate.avatarTone === "teal" ||
    teammate.avatarTone === "violet" ||
    teammate.avatarTone === "blue" ||
    teammate.avatarTone === "rose" ||
    teammate.avatarTone === "gray"
  ) {
    return teammate.avatarTone;
  }
  return teammate.roleKey ? roleAvatarTone(teammate.roleKey) : "gray";
}
