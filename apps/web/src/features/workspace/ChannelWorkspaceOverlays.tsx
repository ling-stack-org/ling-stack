import type { ComponentProps } from "react";
import { ChannelRenameDialog } from "./ChannelRenameDialog.js";
import { ChannelEnvironmentCommitDialog } from "./ChannelEnvironmentCommitDialog.js";
import { WorkflowConversionPreviewDrawer } from "./WorkflowConversionPreviewDialog.js";

export function ChannelWorkspaceOverlays({ rename, commit, conversion }: {
  readonly rename?: ComponentProps<typeof ChannelRenameDialog>;
  readonly commit?: ComponentProps<typeof ChannelEnvironmentCommitDialog>;
  readonly conversion?: ComponentProps<typeof WorkflowConversionPreviewDrawer>;
}): React.JSX.Element {
  return <>{rename ? <ChannelRenameDialog {...rename} /> : null}
    {commit ? <ChannelEnvironmentCommitDialog {...commit} /> : null}
    {conversion ? <WorkflowConversionPreviewDrawer {...conversion} /> : null}</>;
}
