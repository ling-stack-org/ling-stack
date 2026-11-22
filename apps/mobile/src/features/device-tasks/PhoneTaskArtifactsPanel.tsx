import type { RemoteDeviceArtifactOfferV1, RemoteDeviceCollaborationViewV1 } from "@ling-stack/contracts";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { PhoneTaskArtifactPeer, SavedPhoneTaskArtifact } from "../../device/phone-task-artifacts";
import type { StandaloneDeviceRuntime } from "../../device/standalone-runtime";

type ArtifactReceiver = NonNullable<StandaloneDeviceRuntime["artifacts"]>;
type ArtifactStyles = {
  readonly shareButton: ViewStyle;
  readonly row: ViewStyle;
  readonly backText: TextStyle;
  readonly note: TextStyle;
  readonly error: TextStyle;
};

export function PhoneTaskArtifactOffers({ share, peer, artifacts, styles, refreshSaved }: {
  readonly share: Extract<RemoteDeviceCollaborationViewV1, { state: "active" }>;
  readonly peer: PhoneTaskArtifactPeer;
  readonly artifacts: ArtifactReceiver;
  readonly styles: ArtifactStyles;
  readonly refreshSaved: () => void;
}) {
  const [offers, setOffers] = useState<readonly RemoteDeviceArtifactOfferV1[]>([]);
  const [busy, setBusy] = useState<string>();
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { active.current?.abort(); }, []);

  useEffect(() => {
    let current = true;
    void peer.listDeviceArtifacts(share.shareId, share.revision).then(items => {
      if (current && !active.current) { setOffers(items); setError(undefined); }
    }).catch(() => {
      if (current) setError("未能读取电脑提供的文件。");
    });
    return () => { current = false; };
  }, [peer, share]);

  async function operate(offer: RemoteDeviceArtifactOfferV1, decision: "accepted" | "rejected") {
    if (active.current) return;
    const controller = new AbortController();
    const id = offer.manifest.proposalId;
    const replace = (next: RemoteDeviceArtifactOfferV1) =>
      setOffers(previous => previous.map(item => item.manifest.proposalId === id ? next : item));
    active.current = controller;
    setBusy(id);
    setProgress(undefined);
    setError(undefined);
    try {
      const current = offer.status === "proposed" ? await artifacts.decide(offer, decision, peer) : offer;
      if (controller.signal.aborted) return;
      replace(current);
      if (current.status === "accepted") {
        const received = await artifacts.receive({
          offer: current, peer, signal: controller.signal,
          onProgress: (bytes, total) => setProgress(Math.floor(bytes / total * 100)),
        });
        if (!controller.signal.aborted) replace(received);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const code = cause instanceof Error ? cause.message : undefined;
        setError(code === "phone_task_apk_verification_failed" || code === "phone_task_apk_identity_mismatch"
          ? "手机未能确认 APK 的包名、版本和签名。"
          : code === "phone_task_artifact_digest_mismatch"
            ? "文件校验失败，请重新接收。"
            : "未能完成文件接收。可以重新同步后继续。");
      }
    } finally {
      active.current = undefined;
      if (!controller.signal.aborted) { setBusy(undefined); refreshSaved(); }
    }
  }

  return <>
    {offers.map(offer => (
      <View key={offer.manifest.proposalId} style={styles.row}>
        <Text style={styles.backText}>{offer.manifest.name}</Text>
        <Text style={styles.note}>{formatArtifactSize(offer.manifest.sizeBytes)}</Text>
        <ApkIdentity offer={offer} styles={styles} />
        {offer.status === "proposed" ? <>
          <ArtifactButton label="接受并接收" styles={styles} disabled={Boolean(busy)}
            onPress={() => Alert.alert("接收电脑上的文件", `${offer.manifest.name}\n${offer.manifest.targetDeviceId}`, [
              { text: "取消", style: "cancel" },
              { text: "接收", onPress: () => void operate(offer, "accepted") },
            ])} />
          <ArtifactButton label="拒绝文件" styles={styles} disabled={Boolean(busy)} onPress={() => void operate(offer, "rejected")} />
        </> : offer.status === "accepted" ? <>
          <ArtifactButton label={busy === offer.manifest.proposalId ? (progress === undefined ? "准备接收…" : `正在接收 ${progress}%`)
            : offer.receipt ? "重新接收并校验" : "继续接收"}
            styles={styles} disabled={Boolean(busy)} onPress={() => void operate(offer, "accepted")} />
          {offer.receipt ? <Text style={styles.note}>电脑已收到文件校验回执</Text> : null}
        </> : <Text style={styles.note}>已拒绝</Text>}
      </View>
    ))}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </>;
}

export function SavedPhoneTaskArtifacts({ taskId, refresh, artifacts, styles }: {
  readonly taskId: string;
  readonly refresh: number;
  readonly artifacts: ArtifactReceiver;
  readonly styles: ArtifactStyles;
}) {
  const [saved, setSaved] = useState<readonly SavedPhoneTaskArtifact[]>([]);
  const [error, setError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const activeExport = useRef(false);
  useEffect(() => {
    let current = true;
    void artifacts.listSaved(taskId).then(items => { if (current) setSaved(items); })
      .catch(() => { if (current) setError("无法读取本机的文件校验记录。"); });
    return () => { current = false; };
  }, [artifacts, refresh, taskId]);

  async function exportFile(fileId: string) {
    if (activeExport.current) return;
    activeExport.current = true;
    setExporting(true);
    setError(undefined);
    try { await artifacts.export(taskId, fileId); }
    catch { setError("文件未导出。请选择可写入的文件夹，或重新接收文件。"); }
    finally { activeExport.current = false; setExporting(false); }
  }
  return <>
    {saved.map(item => <View key={item.fileId} style={styles.row}>
      <Text style={styles.backText}>{item.offer.manifest.name}</Text>
      <Text style={styles.note}>已校验 · {formatArtifactSize(item.offer.manifest.sizeBytes)}</Text>
      <ApkIdentity offer={item.offer} styles={styles} />
      {item.apkVerification ? <Text style={styles.note}>{item.apkVerification === "android_package_manager"
        ? "本机 Android 已核验 APK 签名和证书" : "已核验配对电脑的 APK 签名证明和文件摘要"}</Text> : null}
      <ArtifactButton label="导出已校验文件" styles={styles} disabled={exporting} onPress={() => void exportFile(item.fileId)} />
    </View>)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </>;
}

function ApkIdentity({ offer, styles }: { readonly offer: RemoteDeviceArtifactOfferV1; readonly styles: ArtifactStyles }) {
  const apk = offer.manifest.androidApk;
  return apk ? <>
    <Text selectable style={styles.note}>{apk.packageId} · 版本 {apk.versionCode}</Text>
    <Text selectable style={styles.note}>签名证书 SHA-256{"\n"}{apk.signerCertificateSha256.join("\n")}</Text>
  </> : null;
}

function ArtifactButton({ label, styles, disabled, onPress }: {
  readonly label: string; readonly styles: ArtifactStyles; readonly disabled: boolean; readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.shareButton}>
    <Text style={styles.backText}>{label}</Text>
  </Pressable>;
}

function formatArtifactSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
