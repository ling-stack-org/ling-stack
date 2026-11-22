import type { RemoteDeviceCollaborationViewV1 } from "@ling-stack/contracts";
import type { RemoteBindingV1, RemoteClientState } from "@ling-stack/remote-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { PhoneTaskCollaborationPeer } from "../../device/phone-task-collaboration";
import type { StandaloneDeviceRuntime } from "../../device/standalone-runtime";
import { useMobileRemote } from "../../remote/MobileRemoteProvider";

type PanelProps = {
  readonly runtime: StandaloneDeviceRuntime;
  readonly taskId: string;
  readonly updatedAt: string;
  readonly styles: {
    readonly shareButton: ViewStyle;
    readonly row: ViewStyle;
    readonly backText: TextStyle;
    readonly note: TextStyle;
    readonly error: TextStyle;
  };
};

export function PhoneTaskCollaborationPanel(props: PanelProps) {
  const { client, binding, remoteState } = useMobileRemote();
  const scope = collaborationScope(binding, remoteState);
  const peer = useMemo<PhoneTaskCollaborationPeer | undefined>(() => scope && client ? {
    scope,
    async update(shareId, action) {
      if (collaborationScope(client.activeBinding, client.state) !== scope) throw new Error("phone_task_pairing_changed");
      return await client.updateDeviceCollaboration(shareId, action);
    },
  } : undefined, [scope, client]);
  return peer ? <ConnectedCollaborationPanel key={peer.scope} {...props} peer={peer} /> : null;
}

function collaborationScope(binding: RemoteBindingV1 | undefined, { connection, policy }: RemoteClientState): string | undefined {
  if (!binding || connection !== "connected" || !policy?.capabilities.includes("device.collaboration")) return undefined;
  return JSON.stringify([binding.gatewayId, binding.deviceId, binding.deviceEpoch, policy.workspaceId, policy.workspaceBindingId, policy.policyVersion]);
}

function ConnectedCollaborationPanel({ runtime, taskId, updatedAt, styles, peer }: PanelProps & { readonly peer: PhoneTaskCollaborationPeer }) {
  const [view, setView] = useState<RemoteDeviceCollaborationViewV1>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef(false);
  const syncedAt = useRef<string | undefined>(undefined);
  const perform = useCallback(async (operation: Parameters<StandaloneDeviceRuntime["collaborate"]>[2]) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await runtime.collaborate(taskId, peer, operation);
      setView(result);
    } catch (cause) {
      const changed = cause instanceof Error && (cause.message === "phone_task_evidence_changed" || cause.message.startsWith("resync_required:"));
      setError(changed ? "设备记录已更新，请同步后再查看建议。" : "未能同步配对电脑上的记录。");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }, [runtime, taskId, peer]);

  useEffect(() => {
    if (busy || syncedAt.current === updatedAt) return;
    syncedAt.current = updatedAt;
    void perform({ kind: "sync" });
  }, [busy, perform, updatedAt]);

  const expiresAt = view?.state === "active" ? view.expiresAt : undefined;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => setView(undefined), Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const share = () => Alert.alert("请配对电脑协助", "向配对电脑共享本次设备诊断摘要，有效期 30 分钟。", [
    { text: "取消", style: "cancel" },
    { text: "共享", onPress: () => void perform({ kind: "share" }) },
  ]);
  const button = (label: string, onPress: () => void) => (
    <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={onPress} style={styles.shareButton}>
      <Text style={styles.backText}>{label}</Text>
    </Pressable>
  );
  return <>
    {view?.state === "active" ? (
      <View>
        <Text style={styles.note}>共享至 {new Date(view.expiresAt).toLocaleTimeString()}</Text>
        {button("同步记录和建议", () => void perform({ kind: "sync" }))}
        {button("结束共享", () => void perform({ kind: "revoke" }))}
        {view.proposals.map(proposal => (
          <View key={proposal.proposalId} style={styles.row}>
            <Text style={styles.note}>{proposal.text}</Text>
            {proposal.status === "proposed" ? <>
              {button("接受建议", () => void perform({ kind: "decide", view, proposalId: proposal.proposalId, decision: "accepted" }))}
              {button("拒绝建议", () => void perform({ kind: "decide", view, proposalId: proposal.proposalId, decision: "rejected" }))}
            </> : <Text style={styles.note}>{proposal.status === "accepted" ? "已接受" : "已拒绝"}</Text>}
          </View>
        ))}
      </View>
    ) : button(busy ? "正在同步…" : "请配对电脑协助", share)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </>;
}
