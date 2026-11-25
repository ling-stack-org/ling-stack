import { createNativeHtmlPreviewDocument, type ConversationVisualization, type ConversationVisualizationReference, type RemoteConversationMessageV1 } from "@ling-stack/contracts";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, AppState, Modal, Pressable, StyleSheet, Text, View, type ViewProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useMobileRemote } from "../../../remote/MobileRemoteProvider";
import { useMobileTheme } from "../../../theme/mobile-theme-provider";

const moduleName = "LingVisualizationPreview";
const Preview = requireOptionalNativeModule(moduleName)
  ? requireNativeView<ViewProps & { readonly html: string; readonly onLoadError: () => void }>(moduleName)
  : undefined;

export function MobileConversationVisualization({ message, reference }: {
  readonly message: RemoteConversationMessageV1;
  readonly reference: ConversationVisualizationReference;
}) {
  const { theme } = useMobileTheme();
  const { client, remoteState } = useMobileRemote();
  const [opened, setOpened] = useState(false);
  const connected = remoteState.connection === "connected";
  const available = connected && client?.supportsConversationVisualizations && Boolean(Preview);
  const binding = remoteState.policy?.workspaceBindingId;
  const load = useCallback(() => {
    if (!client) return Promise.reject(new Error("remote_visualization_unavailable"));
    return client.readConversationVisualization(message.conversationId, message.messageId, message.revision, reference.artifactId);
  }, [client, message.conversationId, message.messageId, message.revision, reference.artifactId]);
  useEffect(() => {
    setOpened(false);
  }, [available, binding]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", state => {
      if (state !== "active") setOpened(false);
    });
    return () => listener.remove();
  }, []);
  return (
    <View style={[styles.card, { borderColor: theme.border.default }]}>
      <Text style={[styles.title, { color: theme.text.strong }]}>{reference.label}</Text>
      {available && client ? (
        <Pressable accessibilityRole="button" style={styles.action} onPress={() => setOpened(true)}>
          <Text style={{ color: theme.text.strong }}>打开可视化</Text>
        </Pressable>
      ) : (
        <Text style={{ color: theme.text.muted }}>{connected ? "此版本暂无法打开可视化" : "连接 PC 后可打开"}</Text>
      )}
      {opened && available && client ? (
        <VisualizationModal
          key={binding}
          label={reference.label}
          onClose={() => setOpened(false)}
          load={load}
        />
      ) : null}
    </View>
  );
}

function VisualizationModal({ label, onClose, load }: {
  readonly label: string;
  readonly onClose: () => void;
  readonly load: () => Promise<ConversationVisualization>;
}) {
  const { theme } = useMobileTheme();
  const [document, setDocument] = useState<ConversationVisualization>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void load().then(result => { if (active) setDocument(result); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [load, revision]);

  const html = useMemo(() => document
    ? createNativeHtmlPreviewDocument(document.html, theme.mode)
    : undefined, [document, theme.mode]);
  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={[styles.screen, { backgroundColor: theme.background.app }]}>
        <View style={[styles.header, { borderBottomColor: theme.border.default }]}>
          <Text accessibilityRole="header" style={[styles.title, styles.headerTitle, { color: theme.text.strong }]}>{document?.title ?? label}</Text>
          <Pressable accessibilityRole="button" style={styles.action} onPress={onClose}>
            <Text style={{ color: theme.text.strong }}>关闭</Text>
          </Pressable>
        </View>
        {document ? <Text style={[styles.summary, { color: theme.text.muted }]}>{document.summary}</Text> : null}
        {html && Preview && !failed ? <Preview style={styles.content} html={html} onLoadError={() => setFailed(true)} /> : null}
        {document?.interaction === "script" && !failed ? (
          <Text style={[styles.summary, { color: theme.text.muted }]}>在电脑上开启脚本交互</Text>
        ) : null}
        {failed ? (
          <View style={styles.status}>
            <Text style={{ color: theme.text.muted }}>无法打开可视化</Text>
            <Pressable accessibilityRole="button" style={styles.action} onPress={() => {
              setDocument(undefined);
              setFailed(false);
              setRevision(value => value + 1);
            }}>
              <Text style={{ color: theme.text.strong }}>重试</Text>
            </Pressable>
          </View>
        ) : !document ? <ActivityIndicator accessibilityLabel="正在读取可视化" style={styles.status} /> : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { minWidth: 150, maxWidth: "100%", gap: 4, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingTop: 8 },
  action: { minHeight: 44, justifyContent: "center" },
  title: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
  screen: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { flex: 1 },
  summary: { paddingHorizontal: 16, paddingVertical: 8 },
  content: { flex: 1 },
  status: { alignItems: "center", gap: 8, padding: 20 },
});
