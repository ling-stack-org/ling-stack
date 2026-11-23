import type { RemoteDeviceArtifactOfferV1, RemoteDeviceBuildArtifactSummaryV1, RemoteDeviceCollaborationViewV1 } from "@ling-stack/contracts";
import { useEffect, useRef, useState } from "react";
import type { DesktopMobileAccessCapabilities } from "../../../../../desktop/shared/desktop-capabilities.js";
import { useI18n } from "../../../i18n.js";
import { Button, Field, InlineFeedback, Select } from "../../../shared/ui/index.js";

export function PhoneTaskArtifactCard({ access, share, canShareBuilds }: {
  readonly access: Pick<DesktopMobileAccessCapabilities, "listDeviceArtifacts" | "offerDeviceArtifact"
    | "listDeviceBuildArtifacts" | "offerDeviceBuildArtifact">;
  readonly share: Extract<RemoteDeviceCollaborationViewV1, { state: "active" }>;
  readonly canShareBuilds: boolean;
}) {
  const { locale, t } = useI18n();
  const { shareId, revision } = share;
  const [offers, setOffers] = useState<readonly RemoteDeviceArtifactOfferV1[]>([]);
  const [builds, setBuilds] = useState<readonly RemoteDeviceBuildArtifactSummaryV1[]>([]);
  const [selectedBuildId, setSelectedBuildId] = useState("");
  const [offering, setOffering] = useState<"file" | "build">();
  const [offersError, setOffersError] = useState(false);
  const [buildsError, setBuildsError] = useState(false);
  const [shareError, setShareError] = useState(false);
  const uploading = useRef(false);
  const refreshVersion = useRef(0);
  const buildProposalIds = useRef(new Map<string, string>());
  const enablesBuilds = canShareBuilds && !!access.listDeviceBuildArtifacts && !!access.offerDeviceBuildArtifact;
  const selectedBuild = builds.find(build => build.buildJobId === selectedBuildId);

  useEffect(() => {
    let active = true;
    const requestVersion = ++refreshVersion.current;
    const query = { shareId, expectedRevision: revision };
    void access.listDeviceArtifacts(query).then(next => {
      if (active && requestVersion === refreshVersion.current) {
        setOffers(next);
        setOffersError(false);
      }
    }).catch(() => {
      if (active && requestVersion === refreshVersion.current) setOffersError(true);
    });
    if (enablesBuilds && access.listDeviceBuildArtifacts) {
      void access.listDeviceBuildArtifacts(query).then(next => {
        if (active) {
          setBuilds(next);
          setBuildsError(false);
        }
      }).catch(() => {
        if (active) setBuildsError(true);
      });
    }
    return () => { active = false; };
  }, [access, enablesBuilds, shareId, revision, share]);

  async function offerArtifact(kind: "file" | "build") {
    if (uploading.current) return;
    uploading.current = true;
    setOffering(kind);
    setShareError(false);
    try {
      let offer: RemoteDeviceArtifactOfferV1 | undefined;
      if (kind === "build") {
        if (!selectedBuild || !access.offerDeviceBuildArtifact) return;
        const { buildJobId } = selectedBuild;
        const proposalId = buildProposalIds.current.get(buildJobId) ?? "phone_build_" + crypto.randomUUID();
        buildProposalIds.current.set(buildJobId, proposalId);
        offer = await access.offerDeviceBuildArtifact({ shareId, expectedRevision: revision, proposalId, buildJobId });
      } else {
        offer = await access.offerDeviceArtifact({ shareId, expectedRevision: revision, proposalId: "phone_artifact_" + crypto.randomUUID() });
      }
      if (offer) {
        refreshVersion.current += 1;
        setOffers(previous => [...previous.filter(item => item.manifest.proposalId !== offer.manifest.proposalId), offer]);
      }
    } catch {
      setShareError(true);
    } finally {
      uploading.current = false;
      setOffering(undefined);
    }
  }

  return <>
    {offers.length ? <ul className="mobile-access-analysis-notes">
      {offers.map(offer => <li key={offer.manifest.proposalId}>
        {offer.manifest.name} <span>{offer.receipt ? t("File verified by phone") : offer.status === "accepted"
          ? t("Waiting for file verification") : offer.status === "rejected" ? t("Rejected") : t("Awaiting phone review")}</span>
      </li>)}
    </ul> : null}
    {enablesBuilds && builds.length ? <>
      <Field label={t("Completed APK build")}>
        <Select value={selectedBuild?.buildJobId ?? ""} disabled={Boolean(offering)} onChange={event => setSelectedBuildId(event.currentTarget.value)}>
          <option value="">{t("Select an APK build")}</option>
          {builds.map(build => <option value={build.buildJobId} key={build.buildJobId}>
            {build.name} · {build.buildId} · {new Date(build.builtAt).toLocaleString(locale)}
          </option>)}
        </Select>
      </Field>
      {selectedBuild ? <div className="mobile-access-build-details">
        <div>{selectedBuild.packageId} · {t("Version")} {selectedBuild.versionCode}</div>
        <code>{selectedBuild.digest}</code>
      </div> : null}
    </> : null}
    {(offersError || (enablesBuilds && buildsError) || shareError)
      ? <InlineFeedback tone="danger">{t("Device files could not be shared or read.")}</InlineFeedback> : null}
    <div className="mobile-access-actions">
      <Button type="button" variant="secondary" disabled={offering === "build"} loading={offering === "file"}
        onClick={() => void offerArtifact("file")}>{t("Share a PC file")}</Button>
      {enablesBuilds && builds.length ? <Button type="button" variant="secondary" disabled={!selectedBuild || offering === "file"}
        loading={offering === "build"} onClick={() => void offerArtifact("build")}>{t("Share APK build")}</Button> : null}
    </div>
  </>;
}
