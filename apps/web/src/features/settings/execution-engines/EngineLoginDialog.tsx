import { ExternalLink, RotateCcw } from "lucide-react";
import { useEffect, type RefObject } from "react";
import { useI18n } from "../../../i18n.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Field, Input } from "../../../shared/ui/index.js";
import { EngineManagementError } from "./EngineManagementError.js";
import { engineLoginPending, type EngineLoginState, type ExecutionEngineLoginController } from "./execution-engine-manager.js";

export function EngineLoginDialog({ controller, state, name, returnFocusRef }: {
  readonly controller: ExecutionEngineLoginController;
  readonly state: EngineLoginState;
  readonly name: string;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const { t } = useI18n();
  const operation = state.operation;
  const active = Boolean(state.pending) || engineLoginPending(operation);
  const cancelling = state.pending === "cancel" || operation?.status === "cancelling";
  useEffect(() => {
    if (state.pending || state.error || !engineLoginPending(operation)) return;
    const timer = window.setTimeout(() => { void controller.refresh(); }, 1_000);
    return () => window.clearTimeout(timer);
  }, [controller, operation, state.pending, state.error]);
  const dismiss = () => { if (active) void controller.cancel(); else controller.close(); };
  const challenge = operation?.challenge;
  const keySetup = state.method === "apiKey";
  const status = cancelling ? t("Cancelling") : state.pending === "start" ? t("Loading")
    : operation?.status === "completed" ? keySetup ? t("API key configured locally") : t("Signed in")
      : operation?.status === "cancelled" ? t("Cancelled")
        : operation?.status === "timed_out" ? keySetup ? t("API key setup timed out") : t("Sign-in timed out")
          : operation?.status === "failed" || (!operation && state.error) ? keySetup ? t("API key setup failed") : t("Sign-in failed")
            : keySetup ? t("Configuring API key") : t("Waiting for sign-in");
  return (
    <Dialog open busy={cancelling} onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent size="md" aria-describedby={undefined} onCloseAutoFocus={(event) => {
        event.preventDefault();
        returnFocusRef.current?.focus({ preventScroll: true });
      }}>
        <DialogHeader title={name} closeLabel={active ? t("Cancel") : t("Close")} />
        <DialogBody className="engine-login-body">
          <p role="status">{status}</p>
          {state.error ? <EngineManagementError code={state.error} /> : null}
          {operation?.status === "failed" && operation.errorCode
            && !["engine_login_failed", "engine_login_login_failed"].includes(operation.errorCode)
            ? <EngineManagementError code={operation.errorCode} /> : null}
          {challenge?.type === "device_code" ? <Field label={t("Device code")}>
            <Input readOnly autoComplete="off" spellCheck={false} value={challenge.userCode} />
          </Field> : null}
          {challenge?.type === "terminal" ? <pre className="engine-login-terminal">{challenge.text}</pre> : null}
          {challenge && challenge.type !== "terminal" ? <Button asChild leadingIcon={<ExternalLink />}>
            <a href={challenge.url} target="_blank" rel="noopener noreferrer" data-desktop-window-no-drag="true">{t("Open sign-in page")}</a>
          </Button> : null}
        </DialogBody>
        <DialogFooter className="engine-profile-footer">
          {state.error && operation && active ? <Button leadingIcon={<RotateCcw />}
            onClick={() => { if (state.cancelRequested) void controller.cancel(); else void controller.refresh(); }}>{t("Retry")}</Button> : null}
          <Button onClick={dismiss} loading={cancelling} loadingLabel={t("Cancelling")}>{active ? t("Cancel") : t("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
