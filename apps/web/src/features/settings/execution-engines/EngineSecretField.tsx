import { KeyRound, Link } from "lucide-react";
import { isExecutionEngineSecretValue } from "@ling-stack/contracts";
import { useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import { Button, Field, Input } from "../../../shared/ui/index.js";

export function EngineSecretField({ label, secretRef, busy, retry, onReference }: {
  readonly label: string;
  readonly secretRef: string | undefined;
  readonly busy: boolean;
  readonly retry: boolean;
  readonly onReference: (value: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const initialRef = useRef(secretRef ?? "");
  const [referenceMode, setReferenceMode] = useState(false);
  return <div className="engine-secret-field">
    {referenceMode ? <Field label={t("secret_reference")} required>
      <Input required autoComplete="off" spellCheck={false} value={secretRef ?? ""} maxLength={512}
        pattern="(env|keychain):\S+" onChange={(event) => onReference(event.target.value)} />
    </Field> : <Field label={label} required={!initialRef.current || retry}>
      <Input key={referenceMode ? "reference" : "secret"} type="password" name="engine-secret"
        required={!initialRef.current || retry} autoComplete="new-password" spellCheck={false} maxLength={2048}
        onChange={(event) => event.currentTarget.setCustomValidity(event.currentTarget.value && !isExecutionEngineSecretValue(event.currentTarget.value) ? t("Invalid configuration") : "")}
        placeholder={initialRef.current && !retry ? t("Secret configured") : undefined} />
    </Field>}
    <Button size="sm" variant="ghost" leadingIcon={referenceMode ? <KeyRound /> : <Link />} disabled={busy}
      onClick={() => { onReference(initialRef.current); setReferenceMode(!referenceMode); }}>
      {referenceMode ? t("Enter secret") : t("Use secret reference")}
    </Button>
  </div>;
}
