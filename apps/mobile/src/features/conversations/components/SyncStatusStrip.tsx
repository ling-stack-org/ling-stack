import type { RemoteConnectionStatus } from "@ling-stack/remote-client";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";

export function SyncStatusStrip({ status, onRetry, compact = false }: {
  readonly status: RemoteConnectionStatus;
  readonly onRetry?: () => void;
  readonly compact?: boolean;
}) {
  const { theme } = useMobileTheme();
  if (status === "connected") {
    return compact ? null : <Text style={[styles.inline, { color: theme.status.success }]}>已同步</Text>;
  }
  const label = status === "connecting"
    ? "正在连接 PC…"
    : status === "reconnecting"
      ? "正在重新连接到 PC…"
      : status === "revoked"
        ? "此设备已取消配对"
        : "离线 · 显示上次同步内容";
  const color = status === "revoked" ? theme.status.danger : status === "disconnected" ? theme.status.warning : theme.status.info;
  return (
    <View accessibilityRole="alert" style={[styles.strip, { backgroundColor: theme.background.subtle }]}>
      <Text style={[styles.stripText, { color }]}>{label}</Text>
      {status === "disconnected" && onRetry ? (
        <Pressable accessibilityRole="button" hitSlop={10} onPress={onRetry}><Text style={[styles.retry, { color: theme.text.strong }]}>重试</Text></Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inline: { fontSize: 12, fontWeight: "600" },
  strip: { minHeight: 36, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stripText: { fontSize: 13, lineHeight: 18 },
  retry: { fontSize: 13, fontWeight: "700" },
});
