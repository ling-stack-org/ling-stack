import { ExternalLink, Wrench } from "lucide-react";
import { useRef } from "react";
import type { ManagedPluginView } from "../../types.js";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import type { PluginActionFailure } from "./plugin-manager-types.js";

export function ChromeBrowserConnectDrawer({
  actionFailure,
  busy,
  onClose,
  onRepairHost,
  open,
  plugin,
}: {
  readonly actionFailure?: PluginActionFailure;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRepairHost: (pluginId: string) => Promise<void>;
  readonly open: boolean;
  readonly plugin?: ManagedPluginView;
}): React.JSX.Element {
  const { t } = useI18n();
  const drawerRef = useRef<HTMLDivElement>(null);
  const state = plugin?.setup?.browserState ?? "extension_required";
  const connected = plugin?.setup?.connected === true;
  const presentation = chromeConnectionPresentation(state, connected, t);

  return (
    <Drawer busy={busy} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }} open={Boolean(open && plugin)}>
      <DrawerContent
        ref={drawerRef}
        className="chrome-connect-panel"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          drawerRef.current?.focus();
        }}
        size="md"
      >
        {plugin ? (
          <>
            <DrawerHeader
              closeLabel={t("Close")}
              description={presentation.description}
              title={t("Chrome connection")}
            />
            <DrawerBody className="chrome-connect-body">
              {actionFailure ? (
                <InlineFeedback title={actionFailure.message} tone="danger">{actionFailure.detail}</InlineFeedback>
              ) : null}
              <InlineFeedback tone={presentation.tone}>{presentation.label}</InlineFeedback>
              {(state === "extension_required" || state === "incompatible") && plugin.setup?.storeUrl ? (
                <Button asChild leadingIcon={<ExternalLink aria-hidden="true" />} size="sm">
                  <a href={plugin.setup.storeUrl} rel="noreferrer" target="_blank">{t("Open Chrome Web Store")}</a>
                </Button>
              ) : null}
              {state === "host_missing" ? (
                <Button
                  leadingIcon={<Wrench aria-hidden="true" />}
                  loading={busy}
                  loadingLabel={t("Repairing connection component")}
                  onClick={() => void onRepairHost(plugin.id)}
                  size="sm"
                  variant="primary"
                >
                  {t("Repair connection component")}
                </Button>
              ) : null}
              <InlineFeedback role="note" tone="neutral">
                {t("When connected, Ling may read HTTP(S) page URLs, visible text, interactive labels, and visible screenshots only for browser tasks you approve. It does not read Chrome passwords, cookies, history, or bookmarks.")}
              </InlineFeedback>
            </DrawerBody>
            <DrawerFooter>
              <Button disabled={busy} onClick={onClose}>{t("Close")}</Button>
            </DrawerFooter>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

function chromeConnectionPresentation(
  state: NonNullable<ManagedPluginView["setup"]>["browserState"],
  connected: boolean,
  t: ReturnType<typeof useI18n>["t"],
): { readonly label: string; readonly description: string; readonly tone: "success" | "neutral" | "warning" | "danger" } {
  if (connected || state === "ready") {
    return {
      label: t("Chrome is connected automatically"),
      description: t("Ling can use Chrome after you approve a browser task."),
      tone: "success",
    };
  }
  if (state === "host_missing") {
    return {
      label: t("Ling Browser Host is missing"),
      description: t("Repair the local connection component, then keep Ling and Chrome open."),
      tone: "warning",
    };
  }
  if (state === "paused") {
    return {
      label: t("Ling for Chrome is paused"),
      description: t("Open Ling for Chrome from the Chrome toolbar and choose Resume."),
      tone: "neutral",
    };
  }
  if (state === "incompatible") {
    return {
      label: t("Ling or the Chrome extension needs an update"),
      description: t("Update Ling and Ling for Chrome before reconnecting."),
      tone: "danger",
    };
  }
  if (state === "waiting_for_chrome") {
    return {
      label: t("Waiting for Chrome"),
      description: t("Open Chrome and make sure Ling for Chrome is enabled."),
      tone: "neutral",
    };
  }
  if (state === "ling_unavailable") {
    return {
      label: t("Ling is not available to Chrome"),
      description: t("Keep Ling running, then reconnect from the extension."),
      tone: "warning",
    };
  }
  return {
    label: t("Ling for Chrome is not installed"),
    description: t("Install Ling for Chrome from the Chrome Web Store. Connection is automatic."),
    tone: "warning",
  };
}
