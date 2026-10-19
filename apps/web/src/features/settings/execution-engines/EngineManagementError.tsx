import { useI18n } from "../../../i18n.js";
import { InlineFeedback } from "../../../shared/ui/index.js";

export function EngineManagementError({ code }: { readonly code: string }): React.JSX.Element {
  const { t } = useI18n();
  const message = code === "profile_revision_conflict"
    ? t("The configuration changed elsewhere. Reload before saving.")
    : code === "profile_in_use" || code === "profile_reference_conflict"
      ? t("This connection is still in use.")
      : code === "engine_host_must_be_local" || code === "engine_host_authority_unavailable"
        ? t("Manage execution engines on their host computer.")
        : code === "engine_authority_required" || code === "engine_session_invalid"
          ? t("The authorization expired.")
          : code === "engine_login_not_found"
            ? t("Not available")
          : code === "engine_secret_store_unavailable"
            ? t("Could not save the secret in system storage. Enter it again to retry.")
          : code === "engine_secret_cleanup_failed"
            ? t("The configuration was not saved. A temporary credential could not be removed.")
          : code.startsWith("engine_secret_") || code === "engine_invalid_secret_ref"
            ? t("The referenced secret is unavailable on this host.")
          : code === "profile_invalid"
            ? t("Invalid configuration")
            : t("Unable to connect");
  return <InlineFeedback tone="warning" role="alert">{message}</InlineFeedback>;
}
