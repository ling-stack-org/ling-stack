import type { RemotePendingSend } from "@ling-stack/remote-client";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { MobileStackParamList } from "../../../navigation/types";
import { useMobileRemote } from "../../../remote/MobileRemoteProvider";
import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import { NativeMessageRow, PendingMessageRow } from "../components/NativeMessageRow";
import { PlainTextComposer } from "../components/PlainTextComposer";
import { SyncStatusStrip } from "../components/SyncStatusStrip";
import { ConversationIdentityAvatar } from "../components/ConversationIdentityAvatar";
import { conversationDetailSubtitle, transcriptDayLabel } from "../domain/conversation-view-model";
import {
  adaptRemoteConversationMessages,
  type MobileConversationMessageViewModel,
} from "../domain/MobileConversationAdapter";
import { useConversationDraft } from "../state/useConversationDraft";

type Props = NativeStackScreenProps<MobileStackParamList, "ConversationDetail">;

type TranscriptItem =
  | { readonly kind: "message"; readonly viewModel: MobileConversationMessageViewModel }
  | { readonly kind: "pending"; readonly send: RemotePendingSend }
  | { readonly kind: "unread"; readonly count: number };

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
  const unreadCountOnOpen = useRef(summary?.unreadCount ?? 0);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const pending = useMemo(
    () => Object.values(remoteState.pendingSends).filter((send) => send.conversationId === conversationId).sort((left, right) => left.issuedAt.localeCompare(right.issuedAt)),
    [remoteState.pendingSends, conversationId],
  );
  const messageViewModels = useMemo(
    () => adaptRemoteConversationMessages(summary?.kind ?? "conversation", detail?.messages ?? []),
    [detail?.messages, summary?.kind],
  );
  const transcriptItems = useMemo<TranscriptItem[]>(() => {
    const messages: TranscriptItem[] = messageViewModels.map((viewModel) => ({ kind: "message", viewModel }));
    const unreadCount = Math.min(unreadCountOnOpen.current, messages.length);
    if (unreadCount > 0) {
      messages.splice(messages.length - unreadCount, 0, { kind: "unread", count: unreadCount });
    }
    return [...messages, ...pending.map((send) => ({ kind: "pending" as const, send }))];
  }, [messageViewModels, pending]);
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
          <Pressable accessibilityLabel="返回会话" accessibilityRole="button" hitSlop={8} onPress={() => navigation.goBack()} style={styles.back}>
            <Ionicons color={theme.text.strong} name="chevron-back" size={25} />
          </Pressable>
          <ConversationIdentityAvatar conversation={summary} size={34} />
          <View style={styles.headerText}><Text numberOfLines={1} style={styles.headerTitle}>{summary.title}</Text><Text numberOfLines={1} style={styles.headerSubtitle}>{conversationDetailSubtitle(summary)}</Text></View>
          <SyncStatusStrip compact status={remoteState.connection} />
        </View>
        {remoteState.connection !== "connected" ? <SyncStatusStrip status={remoteState.connection} onRetry={() => void retryConnection()} /> : null}
        {screenError ? <Text accessibilityRole="alert" style={styles.errorStrip}>{screenError}</Text> : null}
        {!detail ? (
          <View style={styles.center}><ActivityIndicator color={theme.action.accent} /><Text style={styles.muted}>正在同步会话…</Text></View>
        ) : (
          <FlatList
            ref={listRef}
            contentContainerStyle={transcriptItems.length === 0 ? styles.emptyTranscript : styles.transcript}
            data={transcriptItems}
            keyExtractor={(item) => item.kind === "message" ? item.viewModel.id : item.kind === "pending" ? `pending:${item.send.commandId}` : `unread:${item.count}`}
            ListEmptyComponent={<View style={styles.center}><Text style={styles.emptyTitle}>还没有消息</Text><Text style={styles.muted}>从这里继续 PC 上的对话。</Text></View>}
            ListHeaderComponent={(
              <View style={styles.transcriptIntro}>
                {detail.hasMoreOlder ? <Pressable accessibilityRole="button" onPress={() => {
                  if (!client || !detail.olderPageCursor) return;
                  void client.openConversation(conversationId, detail.olderPageCursor).then((handle) => handle.completion).catch(() => undefined);
                }} style={styles.loadOlder}><Text style={styles.action}>加载更早消息</Text></Pressable> : null}
                {summary.kind === "teammate_direct" ? (
                  <View style={styles.dmNote}>
                    <Text style={styles.dmNoteText}>这是与 {summary.title} 的私聊。只同步对话消息，不展示队友记忆、私有文件或工作区详情。</Text>
                  </View>
                ) : transcriptDayLabel(detail.messages[0]?.createdAt) ? (
                  <Text style={styles.day}>{transcriptDayLabel(detail.messages[0]?.createdAt)}</Text>
                ) : null}
              </View>
            )}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onContentSizeChange={() => {
              if (!shouldScrollToEnd.current) return;
              shouldScrollToEnd.current = false;
              listRef.current?.scrollToEnd({ animated: false });
            }}
            renderItem={({ item }) => item.kind === "pending"
              ? <PendingMessageRow send={item.send} onRetry={() => client ? void client.retrySend(item.send.commandId).then((handle) => handle.completion).catch(() => undefined) : undefined} />
              : item.kind === "message"
                ? <NativeMessageRow viewModel={item.viewModel} />
                : <UnreadDivider count={item.count} />}
          />
        )}
        <PlainTextComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          connected={remoteState.connection === "connected"}
          sending={sendInFlight}
          placeholder={summary.kind === "teammate_direct" ? `给 ${summary.title} 发消息…` : "发消息…"}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function UnreadDivider({ count }: { readonly count: number }) {
  const { theme } = useMobileTheme();
  return (
    <View style={stylesShared.unreadDivider}>
      <View style={[stylesShared.unreadLine, { backgroundColor: theme.status.info }]} />
      <Text style={[stylesShared.unreadText, { color: theme.status.info }]}>{count} 条新消息</Text>
      <View style={[stylesShared.unreadLine, { backgroundColor: theme.status.info }]} />
    </View>
  );
}

const stylesShared = StyleSheet.create({
  unreadDivider: { flexDirection: "row", alignItems: "center", gap: 8 },
  unreadLine: { flex: 1, height: StyleSheet.hairlineWidth, opacity: 0.35 },
  unreadText: { fontSize: 11, lineHeight: 15 },
});

function createStyles(theme: ReturnType<typeof useMobileTheme>["theme"]) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.panel },
    header: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border.hairline },
    back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    headerText: { flex: 1, minWidth: 0 },
    headerTitle: { color: theme.text.strong, fontSize: 16, lineHeight: 20, fontWeight: "600" },
    headerSubtitle: { marginTop: 2, color: theme.text.muted, fontSize: 11, lineHeight: 15 },
    transcript: { paddingHorizontal: 14, paddingTop: 18, paddingBottom: 16, gap: 18 },
    emptyTranscript: { flexGrow: 1, paddingHorizontal: 14, paddingTop: 18, paddingBottom: 16 },
    transcriptIntro: { gap: 12 },
    day: { alignSelf: "center", color: theme.text.soft, fontSize: 11, lineHeight: 15 },
    dmNote: { paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: theme.border.default, borderRadius: 10, backgroundColor: theme.background.subtle },
    dmNoteText: { color: theme.text.muted, fontSize: 12, lineHeight: 17 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
    emptyTitle: { color: theme.text.strong, fontSize: 18, fontWeight: "600" },
    muted: { color: theme.text.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
    error: { color: theme.status.danger, fontSize: 15, textAlign: "center" },
    errorStrip: { color: theme.status.danger, backgroundColor: theme.background.subtle, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 8 },
    action: { color: theme.text.strong, fontSize: 13, fontWeight: "700" },
    loadOlder: { alignSelf: "center", minHeight: 32, justifyContent: "center", paddingHorizontal: 16 },
  });
}
