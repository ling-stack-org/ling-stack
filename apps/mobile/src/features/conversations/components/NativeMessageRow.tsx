import type { RemoteConversationMessageV1 } from "@ling-stack/contracts";
import type { RemotePendingSend } from "@ling-stack/remote-client";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import { initials, messageTimestamp } from "../domain/conversation-view-model";
import type { MobileConversationMessageViewModel } from "../domain/MobileConversationAdapter";
import { NativeMessageBody } from "./NativeMessageBody";

export function NativeMessageRow({ viewModel }: { readonly viewModel: MobileConversationMessageViewModel }) {
  const { theme } = useMobileTheme();
  const { message, mine, system, streaming, groupedWithPrevious } = viewModel;
  if (system) {
    return (
      <View style={styles.system}>
        <NativeMessageBody blocks={viewModel.blocks} />
      </View>
    );
  }
  return (
    <View style={[styles.messageRow, mine && styles.messageRowMine, groupedWithPrevious && styles.groupedMessageRow]}>
      {!mine && groupedWithPrevious ? <View style={styles.smallAvatarSpacer} /> : !mine && message.authorAvatarDataUrl ? (
        <Image source={{ uri: message.authorAvatarDataUrl }} style={styles.smallAvatar} />
      ) : !mine ? (
        <View style={[styles.smallAvatar, { backgroundColor: theme.background.subtle }]}>
          <Text style={[styles.smallAvatarText, { color: theme.text.strong }]}>{initials(message.authorLabel)}</Text>
        </View>
      ) : null}
      <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
        {!mine && !groupedWithPrevious ? (
          <View style={styles.messageMeta}>
            <Text style={[styles.author, { color: theme.text.strong }]}>{message.authorLabel}</Text>
            {streaming ? (
              <View style={styles.streaming}>
                <ActivityIndicator color={theme.text.muted} size="small" />
                <Text style={[styles.messageTime, { color: theme.text.muted }]}>正在回复</Text>
              </View>
            ) : <Text style={[styles.messageTime, { color: theme.text.soft }]}>{messageTimestamp(message.createdAt)}</Text>}
          </View>
        ) : null}
        <View style={[mine ? styles.ownBubble : styles.otherBubble, mine && { backgroundColor: theme.background.subtle }]}>
          <NativeMessageBody blocks={viewModel.blocks} emptyFallback={streaming ? "正在回复…" : undefined} />
        </View>
        {mine ? (
          <Text style={[styles.mineMeta, { color: message.status === "failed" ? theme.status.danger : theme.text.soft }]}>
            {messageTimestamp(message.createdAt)} · {localMessageStatus(message.status)}
          </Text>
        ) : null}
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
        <View style={[styles.ownBubble, { backgroundColor: theme.background.subtle }]}>
          <Text selectable style={[styles.body, { color: theme.text.default }]}>{send.body}</Text>
        </View>
        <View style={styles.pendingMeta}>
          <Text style={[styles.mineMeta, { color: send.status === "failed" ? theme.status.danger : theme.text.soft }]}>{messageTimestamp(send.issuedAt)} · {label}</Text>
          {send.status === "failed" && send.error?.retryable ? (
            <Pressable accessibilityRole="button" hitSlop={10} onPress={onRetry}><Text style={[styles.retry, { color: theme.text.strong }]}>重试</Text></Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function localMessageStatus(status: RemoteConversationMessageV1["status"]): string {
  if (status === "failed") return "发送失败";
  if (status === "blocked") return "已阻止";
  if (status === "pending") return "发送中…";
  return "已发送";
}

const styles = StyleSheet.create({
  messageRow: { width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 10 },
  messageRowMine: { justifyContent: "flex-end" },
  groupedMessageRow: { marginTop: -10 },
  smallAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  smallAvatarSpacer: { width: 30, height: 1 },
  smallAvatarText: { fontSize: 11, fontWeight: "700" },
  messageColumn: { maxWidth: "84%", alignItems: "flex-start" },
  messageColumnMine: { alignItems: "flex-end" },
  messageMeta: { minHeight: 16, marginBottom: 4, flexDirection: "row", alignItems: "center", gap: 7 },
  author: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  messageTime: { fontSize: 11, lineHeight: 15 },
  streaming: { flexDirection: "row", alignItems: "center", gap: 5 },
  otherBubble: { paddingVertical: 3 },
  ownBubble: { paddingHorizontal: 12, paddingVertical: 9, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomLeftRadius: 14, borderBottomRightRadius: 5 },
  body: { fontSize: 16, lineHeight: 24 },
  mineMeta: { marginTop: 4, fontSize: 11, lineHeight: 15 },
  system: { alignSelf: "center", maxWidth: "84%", paddingHorizontal: 24, opacity: 0.78 },
  pendingMeta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 12 },
  retry: { fontSize: 12, fontWeight: "700" },
});
