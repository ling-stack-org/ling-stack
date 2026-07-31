import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { MobileStackParamList } from "../../../navigation/types";
import { useMobileRemote } from "../../../remote/MobileRemoteProvider";
import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import { NativeMessageRow, PendingMessageRow } from "../components/NativeMessageRow";
import { PlainTextComposer } from "../components/PlainTextComposer";
import { SyncStatusStrip } from "../components/SyncStatusStrip";
import { conversationGlyph, conversationSubtitle } from "../domain/conversation-view-model";
import { useConversationDraft } from "../state/useConversationDraft";

type Props = NativeStackScreenProps<MobileStackParamList, "ConversationDetail">;

export function ConversationDetailScreen({ navigation, route }: Props) {
  const { theme } = useMobileTheme();
  const { client, remoteState, retryConnection } = useMobileRemote();
  const conversationId = route.params.conversationId;
  const summary = remoteState.conversations[conversationId];
  const detail = remoteState.details[conversationId];
  const bindingId = remoteState.workspaceBindingId ?? "unbound";
  const { draft, setDraft } = useConversationDraft(bindingId, conversationId);
  const [screenError, setScreenError] = useState<string>();
  const listRef = useRef<FlatList>(null);
  const transcriptTail = useRef<string | undefined>(undefined);
  const shouldScrollToEnd = useRef(true);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const pending = useMemo(
    () => Object.values(remoteState.pendingSends).filter((send) => send.conversationId === conversationId).sort((left, right) => left.issuedAt.localeCompare(right.issuedAt)),
    [remoteState.pendingSends, conversationId],
  );
  const sendInFlight = pending.some((send) => send.status === "sending" || send.status === "accepted");
  const currentTranscriptTail = `${conversationId}:${detail?.messages.at(-1)?.messageId ?? ""}:${pending.at(-1)?.commandId ?? ""}`;

  useLayoutEffect(() => {
    shouldScrollToEnd.current = transcriptTail.current !== currentTranscriptTail;
    transcriptTail.current = currentTranscriptTail;
  }, [currentTranscriptTail]);

  useEffect(() => {
    if (!client || remoteState.connection !== "connected") return;
    void client.openConversation(conversationId).then((handle) => handle.completion).catch(() => setScreenError("暂时无法同步这个会话。"));
  }, [client, conversationId, remoteState.connection]);

  useEffect(() => {
    if (!client || remoteState.connection !== "connected" || !detail || detail.barrierSeq <= (detail.readState?.readThroughActivitySeq ?? 0)) return;
    void client.markRead(conversationId, detail.barrierSeq).then((handle) => handle.completion).catch(() => undefined);
  }, [client, conversationId, detail?.barrierSeq, detail?.readState?.readThroughActivitySeq, remoteState.connection]);

  if (!summary) {
    return <SafeAreaView style={styles.screen}><View style={styles.center}><Text style={styles.error}>这个会话已不可用。</Text><Pressable onPress={() => navigation.goBack()}><Text style={styles.action}>返回会话</Text></Pressable></View></SafeAreaView>;
  }

  const send = async (): Promise<void> => {
    if (!client || remoteState.connection !== "connected" || !draft.trim()) return;
    setScreenError(undefined);
    const body = draft;
    try {
      const handle = await client.sendText(conversationId, body);
      setDraft("");
      void handle.completion.catch(() => undefined);
    } catch {
      setScreenError("消息未发送，请检查连接后重试。 ");
    }
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.screen}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="返回会话" accessibilityRole="button" hitSlop={8} onPress={() => navigation.goBack()} style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
          <View style={styles.identity}><Text style={styles.identityText}>{conversationGlyph(summary)}</Text></View>
          <View style={styles.headerText}><Text numberOfLines={1} style={styles.headerTitle}>{summary.title}</Text><Text numberOfLines={1} style={styles.headerSubtitle}>{conversationSubtitle(summary)}</Text></View>
          <SyncStatusStrip compact status={remoteState.connection} />
        </View>
        {remoteState.connection !== "connected" ? <SyncStatusStrip compact status={remoteState.connection} onRetry={() => void retryConnection()} /> : null}
        {screenError ? <Text accessibilityRole="alert" style={styles.errorStrip}>{screenError}</Text> : null}
        {!detail ? (
          <View style={styles.center}><ActivityIndicator color={theme.action.accent} /><Text style={styles.muted}>正在同步会话…</Text></View>
        ) : (
          <FlatList
            ref={listRef}
            contentContainerStyle={detail.messages.length === 0 && pending.length === 0 ? styles.emptyTranscript : styles.transcript}
            data={[...detail.messages, ...pending.map((send) => ({ pending: send }))]}
            keyExtractor={(item) => "pending" in item ? `pending:${item.pending.commandId}` : item.messageId}
            ListEmptyComponent={<View style={styles.center}><Text style={styles.emptyTitle}>还没有消息</Text><Text style={styles.muted}>从这里继续 PC 上的对话。</Text></View>}
            ListHeaderComponent={detail.hasMoreOlder ? <Pressable accessibilityRole="button" onPress={() => {
              if (!client || !detail.olderPageCursor) return;
              void client.openConversation(conversationId, detail.olderPageCursor).then((handle) => handle.completion).catch(() => undefined);
            }} style={styles.loadOlder}><Text style={styles.action}>加载更早消息</Text></Pressable> : null}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onContentSizeChange={() => {
              if (!shouldScrollToEnd.current) return;
              shouldScrollToEnd.current = false;
              listRef.current?.scrollToEnd({ animated: false });
            }}
            renderItem={({ item }) => "pending" in item
              ? <PendingMessageRow send={item.pending} onRetry={() => client ? void client.retrySend(item.pending.commandId).then((handle) => handle.completion).catch(() => undefined) : undefined} />
              : <NativeMessageRow message={item} />}
          />
        )}
        <PlainTextComposer value={draft} onChange={setDraft} onSend={() => void send()} connected={remoteState.connection === "connected"} sending={sendInFlight} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useMobileTheme>["theme"]) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.panel },
    header: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border.default },
    back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    backText: { color: theme.text.strong, fontSize: 38, lineHeight: 40, fontWeight: "300", marginTop: -3 },
    identity: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: theme.background.subtle },
    identityText: { color: theme.text.strong, fontSize: 14, fontWeight: "700" },
    headerText: { flex: 1, minWidth: 0 },
    headerTitle: { color: theme.text.strong, fontSize: 16, lineHeight: 20, fontWeight: "600" },
    headerSubtitle: { color: theme.text.muted, fontSize: 11, lineHeight: 15 },
    transcript: { paddingVertical: 10 },
    emptyTranscript: { flexGrow: 1 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
    emptyTitle: { color: theme.text.strong, fontSize: 18, fontWeight: "600" },
    muted: { color: theme.text.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
    error: { color: theme.status.danger, fontSize: 15, textAlign: "center" },
    errorStrip: { color: theme.status.danger, backgroundColor: theme.background.subtle, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 8 },
    action: { color: theme.text.strong, fontSize: 13, fontWeight: "700" },
    loadOlder: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 16 },
  });
}
