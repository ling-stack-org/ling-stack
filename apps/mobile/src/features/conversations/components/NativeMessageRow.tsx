import type { RemoteConversationMessageV1 } from "@ling-stack/contracts";
import type { RemotePendingSend } from "@ling-stack/remote-client";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import { initials, relativeTimestamp } from "../domain/conversation-view-model";

export function NativeMessageRow({ message }: { readonly message: RemoteConversationMessageV1 }) {
  const { theme } = useMobileTheme();
  const mine = message.role === "local_user";
  if (message.role === "system") {
    return <Text style={[styles.system, { color: theme.text.muted }]}>{message.body}</Text>;
  }
  return (
    <View style={[styles.messageRow, mine && styles.messageRowMine]}>
      {!mine ? <View style={[styles.smallAvatar, { backgroundColor: theme.background.subtle }]}><Text style={[styles.smallAvatarText, { color: theme.text.strong }]}>{initials(message.authorLabel)}</Text></View> : null}
      <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
        {!mine ? <Text style={[styles.author, { color: theme.text.muted }]}>{message.authorLabel} · {relativeTimestamp(message.createdAt)}</Text> : null}
        <View style={[styles.bubble, mine ? { backgroundColor: theme.background.subtle } : { backgroundColor: "transparent" }]}>
          <Text selectable style={[styles.body, { color: theme.text.default }]}>{message.body || (message.status === "pending" ? "正在回复…" : "")}</Text>
        </View>
        {mine ? <Text style={[styles.mineMeta, { color: theme.text.muted }]}>{relativeTimestamp(message.createdAt)}</Text> : null}
      </View>
    </View>
  );
}

export function PendingMessageRow({ send, onRetry }: { readonly send: RemotePendingSend; readonly onRetry: () => void }) {
  const { theme } = useMobileTheme();
  const label = send.status === "failed" ? "发送失败" : send.status === "completed" ? "已发送" : "发送中…";
  return (
    <View style={[styles.messageRow, styles.messageRowMine]}>
      <View style={[styles.messageColumn, styles.messageColumnMine]}>
        <View style={[styles.bubble, { backgroundColor: theme.background.subtle }]}>
          <Text selectable style={[styles.body, { color: theme.text.default }]}>{send.body}</Text>
        </View>
        <View style={styles.pendingMeta}>
          <Text style={[styles.mineMeta, { color: send.status === "failed" ? theme.status.danger : theme.text.muted }]}>{label}</Text>
          {send.status === "failed" && send.error?.retryable ? (
            <Pressable accessibilityRole="button" hitSlop={10} onPress={onRetry}><Text style={[styles.retry, { color: theme.text.strong }]}>重试</Text></Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  messageRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingVertical: 7 },
  messageRowMine: { justifyContent: "flex-end" },
  smallAvatar: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: 18 },
  smallAvatarText: { fontSize: 11, fontWeight: "700" },
  messageColumn: { maxWidth: "84%", alignItems: "flex-start", gap: 3 },
  messageColumnMine: { alignItems: "flex-end" },
  author: { fontSize: 12, lineHeight: 16, marginLeft: 4 },
  bubble: { borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9 },
  body: { fontSize: 16, lineHeight: 24 },
  mineMeta: { fontSize: 11, lineHeight: 15, marginHorizontal: 4 },
  system: { alignSelf: "center", fontSize: 12, lineHeight: 18, paddingHorizontal: 24, paddingVertical: 8, textAlign: "center" },
  pendingMeta: { flexDirection: "row", alignItems: "center", gap: 12 },
  retry: { fontSize: 12, fontWeight: "700" },
});
