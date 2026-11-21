import type { DeviceTaskStatusV1, RemoteDeviceApprovalPreviewV1, RemoteDeviceReconciliationPreviewV1 } from "@ling-stack/contracts";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useMobileRemote } from "../../remote/MobileRemoteProvider";
import type { MobileThemeTokens } from "../../theme/mobile-theme";
import { useMobileTheme } from "../../theme/mobile-theme-provider";
import { PcDeviceTaskJournal } from "./PcDeviceTaskJournal";

const taskStatusLabels: Record<DeviceTaskStatusV1, string> = {
  created: "待处理",
  target_resolved: "已确认设备",
  capabilities_loaded: "已读取设备能力",
  planning: "正在规划",
  awaiting_approval: "等待确认",
  executing: "正在执行",
  verifying: "正在复测",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果待确认",
};

type DeviceTaskDecision =
  | { readonly kind: "approve"; readonly preview: RemoteDeviceApprovalPreviewV1 }
  | { readonly kind: "revoke" }
  | { readonly kind: "reconcile"; readonly preview: RemoteDeviceReconciliationPreviewV1 };
type DeviceTaskAction = DeviceTaskDecision["kind"];

export function PcDeviceTasksScreen() {
  const { client, remoteState } = useMobileRemote();
  const { theme } = useMobileTheme();
  const styles = createStyles(theme);
  const { connection, deviceOverview, deviceOverviewCurrent, deviceTask, deviceTaskCurrent } = remoteState;
  const canRead = remoteState.policy?.capabilities.includes("device.read") === true;
  const canReadJournal = remoteState.policy?.capabilities.includes("device.journal") === true;
  const canApprove = remoteState.policy?.capabilities.includes("device.approve") === true;
  const canRevoke = remoteState.policy?.capabilities.includes("device.revoke") === true;
  const canReconcile = remoteState.policy?.capabilities.includes("device.reconcile") === true;
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [failedTaskId, setFailedTaskId] = useState<string>();
  const runningActions = useRef<Partial<Record<DeviceTaskAction, string>>>({});
  const [actionTaskIds, setActionTaskIds] = useState(runningActions.current);
  const [actionFailed, setActionFailed] = useState<string>();
  const [unresolvedTaskId, setUnresolvedTaskId] = useState<string>();
  const detail = deviceTask?.task.taskId === selectedTaskId ? deviceTask?.task : undefined;
  const connected = connection === "connected";
  const selectedTask = deviceOverview?.recentTasks?.find(task => task.taskId === selectedTaskId);
  const selectedTaskUpdatedAt = selectedTask?.updatedAt;

  useEffect(() => {
    if (!client || !canRead || !connected || !deviceOverviewCurrent || !selectedTaskId || !selectedTaskUpdatedAt) return;
    let active = true;
    setFailedTaskId(undefined);
    void client.requestDeviceTaskStatus(selectedTaskId)
      .then(request => request.completion)
      .catch(() => { if (active) setFailedTaskId(selectedTaskId); });
    return () => { active = false; };
  }, [client, canRead, connected, deviceOverviewCurrent, selectedTaskId, selectedTaskUpdatedAt]);

  const refresh = async () => {
    if (!client || !canRead || !connected || refreshing) return;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      await (await client.requestDeviceList()).completion;
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  };

  const deviceName = (deviceId: string) =>
    deviceOverview?.devices.find(device => device.deviceId === deviceId)?.displayName ?? deviceId;

  const runTaskAction = async (taskId: string, decision: DeviceTaskDecision) => {
    const { kind } = decision;
    if (!client || runningActions.current[kind]) return;
    runningActions.current = { ...runningActions.current, [kind]: taskId };
    setActionTaskIds(runningActions.current);
    setActionFailed(undefined);
    try {
      switch (decision.kind) {
        case "approve":
          await (await client.approveDeviceTask(taskId, decision.preview)).completion;
          break;
        case "revoke":
          await (await client.revokeDeviceTask(taskId)).completion;
          break;
        case "reconcile": {
          setUnresolvedTaskId(undefined);
          const result = await (await client.reconcileDeviceTask(taskId, decision.preview)).completion;
          if (result.status === "unresolved") setUnresolvedTaskId(taskId);
          break;
        }
      }
    } catch {
      setActionFailed(taskId);
    } finally {
      runningActions.current = { ...runningActions.current, [kind]: undefined };
      setActionTaskIds(runningActions.current);
    }
  };

  const confirmApproval = (taskId: string, preview: RemoteDeviceApprovalPreviewV1) => {
    Alert.alert("批准设备操作", `${deviceName(preview.targetDeviceId)}\n${preview.capabilityId}\n由 PC 执行 · ${sideEffectLabel(preview.sideEffect)}\n${verificationLabel(preview.expectedVerification)}`, [
      { text: "返回", style: "cancel" },
      { text: "批准执行", onPress: () => void runTaskAction(taskId, { kind: "approve", preview }) },
    ]);
  };

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl enabled={connected && canRead} onRefresh={() => void refresh()} refreshing={refreshing} />}
      >
        {!canRead ? <Text style={styles.note}>当前 PC 未开放设备任务查看。</Text> : (
          <>
            {deviceOverview ? (
              <Text accessibilityLiveRegion="polite" style={styles.note}>
                {deviceOverviewCurrent ? "同步于" : connected ? "正在同步 · 上次更新" : "PC 离线 · 上次更新"} {formatTime(deviceOverview.generatedAt)}
              </Text>
            ) : <Text style={styles.note}>{connected ? "正在读取设备与任务…" : "等待 PC 连接"}</Text>}
            {refreshFailed && connected ? <Text accessibilityRole="alert" style={styles.note}>刷新失败，请下拉重试。</Text> : null}
            {deviceOverview ? (
              <>
                <Text accessibilityRole="header" style={styles.heading}>设备</Text>
                {deviceOverview.devices.length === 0 ? <Text style={styles.note}>PC 暂无已登记设备。</Text> : null}
                {deviceOverview.devices.map(device => (
                  <View key={device.deviceId} style={styles.row}>
                    <Text style={styles.label}>{device.displayName}</Text>
                    <Text style={styles.note}>{device.adapterId} · {device.lifecycleStatus}</Text>
                  </View>
                ))}
                <Text accessibilityRole="header" style={styles.heading}>最近任务</Text>
                {deviceOverview.recentTasks?.length === 0 ? <Text style={styles.note}>PC 暂无设备任务。</Text> : null}
                {deviceOverview.recentTasks === undefined ? <Text style={styles.note}>当前 PC 未提供任务列表。</Text> : null}
                {deviceOverview.recentTasks?.map(task => {
                  const currentDetail = detail && detail.taskId === task.taskId && detail.updatedAt >= task.updatedAt ? detail : undefined;
                  const liveDetail = connected && deviceOverviewCurrent && deviceTaskCurrent ? currentDetail : undefined;
                  const preview = liveDetail?.pendingApproval;
                  const reconciliation = canReconcile ? liveDetail?.pendingReconciliation : undefined;
                  const stoppable = liveDetail && !["failed", "succeeded", "cancelled", "unknown"].includes(liveDetail.status);
                  return (
                  <View key={task.taskId} style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: task.taskId === selectedTaskId }}
                      onPress={() => setSelectedTaskId(task.taskId === selectedTaskId ? undefined : task.taskId)}
                      style={styles.taskButton}
                    >
                      <Text style={styles.label}>{deviceName(task.primaryTargetDeviceId)} · {taskStatusLabels[currentDetail?.status ?? task.status]}</Text>
                      <Text style={styles.note}>{formatTime(currentDetail?.updatedAt ?? task.updatedAt)}</Text>
                    </Pressable>
                    {task.taskId === selectedTaskId ? (
                      <View style={styles.detail}>
                        <Text selectable style={styles.note}>任务编号 {task.taskId}</Text>
                        {currentDetail ? (
                          <>
                            <Text style={styles.note}>执行主机 PC · {currentDetail.ownerId}</Text>
                            <Text style={styles.note}>执行记录 {currentDetail.attemptIds.length} 条</Text>
                            {currentDetail.lastVerificationId ? <Text selectable style={styles.note}>复测记录 {currentDetail.lastVerificationId}</Text> : null}
                            {reconciliation ? (
                              <View style={styles.approval}>
                                <Text style={styles.note}>由 PC 读取 {deviceName(reconciliation.targetDeviceId)} 的当前状态。</Text>
                                <View style={styles.actions}>
                                  <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: actionTaskIds.reconcile !== undefined }}
                                    disabled={actionTaskIds.reconcile !== undefined}
                                    onPress={() => void runTaskAction(task.taskId, { kind: "reconcile", preview: reconciliation })}
                                    style={styles.secondaryAction}
                                  >
                                    <Text style={styles.secondaryActionText}>{actionTaskIds.reconcile === task.taskId ? "正在复测…" : "复测设备"}</Text>
                                  </Pressable>
                                </View>
                              </View>
                            ) : null}
                            {unresolvedTaskId === task.taskId && currentDetail.status === "unknown" ? (
                              <Text accessibilityLiveRegion="polite" style={styles.note}>本次复测未能确认设备状态。</Text>
                            ) : null}
                            {preview || (canRevoke && stoppable) ? (
                              <View style={styles.approval}>
                                {preview ? <View style={styles.approvalSummary}>
                                  <Text style={styles.note}>待确认操作 {preview.capabilityId} · {deviceName(preview.targetDeviceId)}</Text>
                                  <Text style={styles.note}>影响级别 {sideEffectLabel(preview.sideEffect)}</Text>
                                  <Text style={styles.note}>{verificationLabel(preview.expectedVerification)}</Text>
                                </View> : null}
                                <View style={styles.actions}>
                                  {preview && canApprove ? <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: actionTaskIds.approve !== undefined || actionTaskIds.revoke === task.taskId }}
                                    disabled={actionTaskIds.approve !== undefined || actionTaskIds.revoke === task.taskId}
                                    onPress={() => confirmApproval(task.taskId, preview)}
                                    style={styles.primaryAction}
                                  >
                                    <Text style={styles.primaryActionText}>{actionTaskIds.approve === task.taskId ? "已请求批准" : "批准执行"}</Text>
                                  </Pressable> : null}
                                  {canRevoke && stoppable ? <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: actionTaskIds.revoke !== undefined }}
                                    disabled={actionTaskIds.revoke !== undefined}
                                    onPress={() => void runTaskAction(task.taskId, { kind: "revoke" })}
                                    style={styles.secondaryAction}
                                  >
                                    <Text style={styles.secondaryActionText}>撤销</Text>
                                  </Pressable> : null}
                                </View>
                              </View>
                            ) : null}
                            {actionFailed === task.taskId ? <Text accessibilityRole="alert" style={styles.note}>操作请求失败，请刷新任务状态。</Text> : null}
                          </>
                        ) : <Text style={styles.note}>
                          {!connected ? "连接 PC 后读取执行记录" : failedTaskId === task.taskId ? "读取失败，请重新打开此任务。" : "正在读取执行记录…"}
                        </Text>}
                        {canReadJournal && client ? (
                          <PcDeviceTaskJournal
                            key={remoteState.workspaceBindingId}
                            client={client} taskId={task.taskId} connected={connected && deviceOverviewCurrent === true}
                            updatedAt={currentDetail?.updatedAt ?? task.updatedAt} theme={theme}
                          />
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function sideEffectLabel(value: RemoteDeviceApprovalPreviewV1["sideEffect"]): string {
  return { read_only: "只读", reversible: "可逆操作", mutating: "设备变更", irreversible: "不可逆变更", critical: "关键操作" }[value];
}

function verificationLabel(value: RemoteDeviceApprovalPreviewV1["expectedVerification"]): string {
  if (value === undefined || value === null) return "任务未提供具体复测条件";
  if (typeof value !== "object" || Array.isArray(value)) return "PC 将按任务记录复测";
  const labels: Readonly<Record<string, string>> = {
    connected: "网络地址", routeAvailable: "路由", gatewayReachable: "网关连通性",
    dnsReachable: "DNS 连通性", dnsNameResolved: "域名解析", wifiAssociated: "Wi‑Fi 关联",
  };
  const entries = Object.entries(value);
  if (entries.length && entries.every(([key, expected]) => Object.hasOwn(labels, key) && typeof expected === "boolean")) {
    return `复测 ${entries.map(([key, expected]) => `${labels[key]} ${expected ? "可用" : "不可用"}`).join(" · ")}`;
  }
  return "PC 将按任务记录复测";
}

function createStyles(theme: MobileThemeTokens) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.app },
    content: { padding: 16, gap: 8 },
    heading: { marginTop: 12, color: theme.text.strong, fontSize: 17, fontWeight: "600" },
    row: { padding: 12, gap: 4, borderRadius: theme.radius.large, backgroundColor: theme.background.panel },
    taskButton: { minHeight: 44, justifyContent: "center", gap: 4 },
    label: { color: theme.text.strong, fontSize: 15, fontWeight: "600" },
    note: { color: theme.text.muted, fontSize: 13, lineHeight: 19 },
    detail: { paddingTop: 8, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border.default },
    approval: { paddingTop: 8, gap: 8 },
    approvalSummary: { gap: 2 },
    actions: { flexDirection: "row", gap: 8 },
    primaryAction: { minHeight: 40, paddingHorizontal: 14, borderRadius: theme.radius.medium, justifyContent: "center", backgroundColor: theme.action.accent },
    primaryActionText: { color: theme.action.foreground, fontSize: 14, fontWeight: "600" },
    secondaryAction: { minHeight: 40, paddingHorizontal: 14, borderRadius: theme.radius.medium, justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border.default },
    secondaryActionText: { color: theme.text.strong, fontSize: 14, fontWeight: "600" },
  });
}
