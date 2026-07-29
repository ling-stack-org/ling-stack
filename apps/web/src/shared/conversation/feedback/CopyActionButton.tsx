import {
  CopyActionButton as SharedCopyActionButton,
  type CopyActionButtonProps as SharedCopyActionButtonProps,
} from "@ling-stack/conversation-ui-react";
import { useI18n } from "../../../i18n.js";

export type CopyActionButtonProps = SharedCopyActionButtonProps;

export function CopyActionButton({
  copiedLabel,
  ...props
}: CopyActionButtonProps): JSX.Element {
  const { t } = useI18n();
  return <SharedCopyActionButton {...props} copiedLabel={copiedLabel ?? t("Copied")} />;
}
