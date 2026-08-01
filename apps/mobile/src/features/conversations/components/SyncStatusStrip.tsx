import type { RemoteConnectionStatus } from "@ling-stack/remote-client";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";

export function SyncStatusStrip({ status, onRetry, compact = false }: {
  readonly status: RemoteConnectionStatus;
  readonly onRetry?: () => void;
  readonly compact?: boolean;
}) {
  const { theme } = useMobileTheme();
  const label = status === "connected"
    ? "已同步"
    : status === "connecting"
    ? "正在连接 PC…"
    : status === "reconnecting"
      ? "正在重新连接到 PC…"
      : status === "revoked"
        ? "此设备已取消配对"
        : "离线 · 显示上次同步内容";
  const color = status === "connected"
    ? theme.status.success
    : status === "revoked"
      ? theme.status.danger
      : status === "disconnected"
        ? theme.status.warning
        : theme.status.info;
  if (compact) {
    return (
      <View accessibilityLabel={label} style={styles.inline}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={[styles.inlineText, { color: theme.text.muted }]}>{label}</Text>
      </View>
    );
  }
  if (status === "connected") {
    return null;
  }
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.strip,
        {
          backgroundColor: status === "revoked" ? theme.status.infoBackground : theme.status.warningBackground,
          borderTopColor: status === "revoked" ? theme.border.default : theme.status.warningBorder,
        },
      ]}
    >
      <View style={styles.bannerCopy}>
        <Ionicons color={color} name="sync-outline" size={14} />
        <Text style={[styles.stripText, { color }]}>{label}</Text>
      </View>
      {status === "disconnected" && onRetry ? (
        <Pressable accessibilityRole="button" hitSlop={10} onPress={onRetry}><Text style={[styles.retry, { color: theme.text.strong }]}>重试</Text></Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 999 },
  inlineText: { fontSize: 12, lineHeight: 16 },
  strip: { minHeight: 38, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", borderTopWidth: 1 },
  bannerCopy: { flexDirection: "row", alignItems: "center", gap: 7 },
  stripText: { fontSize: 12, lineHeight: 18, fontWeight: "600" },
  retry: { fontSize: 13, fontWeight: "700" },
});
