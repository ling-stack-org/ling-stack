import { useEffect, useState } from "react";
import { attachmentContentUrlById } from "../../api.js";
import { AvatarInitial, type AvatarTone } from "../../shared/components/index.js";
import type { AiTeammate } from "../../types.js";
import { defaultTeammateAvatarSrc } from "./default-teammate-avatars.js";
import { roleAvatarTone, teammateInitialFromName } from "./helpers.js";

export interface TeammateAvatarLike {
  readonly displayName: string;
  readonly templateId?: string;
  readonly kind?: AiTeammate["kind"];
  readonly systemRole?: AiTeammate["systemRole"];
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
}): React.JSX.Element {
  const defaultAvatarSrc = defaultTeammateAvatarSrc(teammate);
  const [attachmentAvatarFailed, setAttachmentAvatarFailed] = useState(false);
  const [defaultAvatarFailed, setDefaultAvatarFailed] = useState(false);
  useEffect(() => {
    setAttachmentAvatarFailed(false);
    setDefaultAvatarFailed(false);
  }, [defaultAvatarSrc, teammate.avatarImageAttachmentId]);

  if (teammate.avatarImageAttachmentId && !attachmentAvatarFailed) {
    return (
      <img
        className={`teammate-avatar-image ${compact ? "compact" : ""}`}
        src={attachmentContentUrlById(teammate.avatarImageAttachmentId, cwd.trim())}
        alt=""
        onError={() => setAttachmentAvatarFailed(true)}
      />
    );
  }
  if (!defaultAvatarFailed) {
    return (
      <img
        className={`teammate-avatar-image teammate-avatar-image-default ${compact ? "compact" : ""}`}
        src={defaultAvatarSrc}
        alt=""
        onError={() => setDefaultAvatarFailed(true)}
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
