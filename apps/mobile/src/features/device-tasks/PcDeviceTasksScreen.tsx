import type { DeviceTaskStatusV1 } from "@ling-stack/contracts";
import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useMobileRemote } from "../../remote/MobileRemoteProvider";
import type { MobileThemeTokens } from "../../theme/mobile-theme";
import { useMobileTheme } from "../../theme/mobile-theme-provider";

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

export function PcDeviceTasksScreen() {
  const { client, remoteState } = useMobileRemote();
  const { theme } = useMobileTheme();
  const styles = createStyles(theme);
  const { connection, deviceOverview, deviceOverviewCurrent, deviceTask } = remoteState;
  const canRead = remoteState.policy?.capabilities.includes("device.read") === true;
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [failedTaskId, setFailedTaskId] = useState<string>();
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
                          </>
                        ) : <Text style={styles.note}>
                          {!connected ? "连接 PC 后读取执行记录" : failedTaskId === task.taskId ? "读取失败，请重新打开此任务。" : "正在读取执行记录…"}
                        </Text>}
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
  });
}
