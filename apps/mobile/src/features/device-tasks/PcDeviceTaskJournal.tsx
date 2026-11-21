import {
  REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1,
  type DeviceEventEnvelopeV1,
  type RemoteDeviceTaskJournalV1,
} from "@ling-stack/contracts";
import type { RemoteSessionClient } from "@ling-stack/remote-client";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { MobileThemeTokens } from "../../theme/mobile-theme";

const eventLabels: Readonly<Record<string, string>> = {
  task_created: "任务已登记",
  task_transition: "任务状态已更新",
  device_plan_accepted: "执行计划已记录",
  attempt_prepared: "已记录执行意图",
  attempt_updated: "执行回执已更新",
  task_stop_requested: "已请求停止",
  attempt_reconciled: "已记录复测结果",
  observation_recorded: "已记录设备观察",
};

export function PcDeviceTaskJournal({ client, taskId, connected, updatedAt, theme }: {
  readonly client: RemoteSessionClient;
  readonly taskId: string;
  readonly connected: boolean;
  readonly updatedAt?: string;
  readonly theme: MobileThemeTokens;
}) {
  const [view, setView] = useState<RemoteDeviceTaskJournalV1>();
  const [navigation, setNavigation] = useState<{ readonly afterSequence: number }>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const retained = useRef<{ readonly view: RemoteDeviceTaskJournalV1; readonly navigation: typeof navigation }>(undefined);
  const styles = createStyles(theme);

  useEffect(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
    let active = true;
    const previous = retained.current?.view;
    const hasNavigation = navigation !== retained.current?.navigation;
    const isResuming = previous !== undefined && !previous.hasMore && !hasNavigation;
    const afterSequence = hasNavigation ? navigation?.afterSequence ?? 0
      : isResuming ? previous.events.at(-1)?.sequence ?? previous.afterSequence
      : previous?.afterSequence ?? 0;
    setLoading(true);
    setFailed(false);

    async function load() {
      let page = await client.readDeviceTaskJournal(taskId, { generation: previous?.generation ?? 1, afterSequence });
      if (!active) return;
      if (page.requiresSnapshot) {
        page = await client.readDeviceTaskJournal(taskId, { generation: page.generation, afterSequence: 0 });
        if (!active) return;
        if (page.requiresSnapshot) throw new Error("device journal generation changed");
      } else if (isResuming) {
        const events = [...previous.events, ...page.events].slice(-REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1);
        page = { ...page, events, afterSequence: events[0] ? events[0].sequence - 1 : page.afterSequence };
      }
      retained.current = { view: page, navigation };
      setView(page);
    }

    void load().catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, connected, navigation, refresh, taskId, updatedAt]);

  const button = (label: string, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !connected || loading }}
      disabled={!connected || loading} onPress={onPress} style={styles.button}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.journal}>
      <Text accessibilityRole="header" style={styles.heading}>PC 任务日志</Text>
      {view?.events.map(event => (
        <Text key={event.eventId} style={styles.line}>{eventLabel(event)} · {new Date(event.occurredAt).toLocaleTimeString()}</Text>
      ))}
      {!connected ? <Text style={styles.line}>连接 PC 后可续读。</Text> : null}
      {loading && !view ? <Text style={styles.line}>正在读取任务日志…</Text> : null}
      {view?.latestSequence === 0 && !loading ? <Text style={styles.line}>暂无任务记录。</Text> : null}
      {failed ? <Text accessibilityRole="alert" style={styles.line}>任务日志读取失败。</Text> : null}
      {connected ? <View style={styles.actions}>
        {view && view.afterSequence > 0
          ? button("上一页", () => setNavigation({ afterSequence: Math.max(0, view.afterSequence - REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1) }))
          : null}
        {view?.hasMore && view.events.length > 0
          ? button("下一页", () => setNavigation({ afterSequence: view.events.at(-1)!.sequence }))
          : button("刷新日志", () => setRefresh(value => value + 1))}
      </View> : null}
    </View>
  );
}

function eventLabel(event: DeviceEventEnvelopeV1): string {
  const label = eventLabels[event.kind] ?? "任务记录已更新";
  const payload = event.payload;
  if (event.kind === "attempt_reconciled" && payload && typeof payload === "object" && "status" in payload) {
    return payload.status === "verified" ? "复测已确认设备状态" : "复测仍无法确认设备状态";
  }
  return label;
}

function createStyles(theme: MobileThemeTokens) {
  return StyleSheet.create({
    journal: { gap: 4, marginTop: 8 },
    heading: { color: theme.text.strong, fontSize: 14, fontWeight: "600" },
    line: { color: theme.text.muted, fontSize: 13, lineHeight: 19 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    button: {
      minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border.default, borderRadius: theme.radius.medium,
    },
    buttonLabel: { color: theme.text.strong, fontSize: 13, fontWeight: "600" },
  });
}
