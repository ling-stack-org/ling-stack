import type { LingServerConfirmedPairingMigrationV1 } from "@ling-stack/contracts";
import { validateLingServerConfirmedPairingMigrationV1 } from "@ling-stack/remote-protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useMobileRemote } from "../../remote/MobileRemoteProvider";
import type { MobileThemeTokens } from "../../theme/mobile-theme";
import { useMobileTheme } from "../../theme/mobile-theme-provider";

const MAX_MIGRATION_RECORD_LENGTH = 64 * 1024;
const PIN_VERIFICATION_TIMEOUT_MS = 15_000;

export function LingServerPairingScreen() {
  const { binding, client, confirmLingServerPairingPin } = useMobileRemote();
  const { theme } = useMobileTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [record, setRecord] = useState("");
  const [preview, setPreview] = useState<LingServerConfirmedPairingMigrationV1>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController>(undefined);
  const saved = binding?.lingServerRoutingProfile;
  const transport = client?.connectionTransport;

  useEffect(() => () => pending.current?.abort(), []);

  const review = () => {
    try {
      const value: unknown = JSON.parse(record);
      setPreview(validateLingServerConfirmedPairingMigrationV1(value));
      setError(undefined);
    } catch {
      setError("无法读取迁移记录。请粘贴从已绑定的 PC 导出的完整 JSON。");
    }
  };

  const confirm = async () => {
    if (!preview || !client || pending.current) return;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(PIN_VERIFICATION_TIMEOUT_MS);
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await confirmLingServerPairingPin(preview, AbortSignal.any([controller.signal, deadline]));
      if (controller.signal.aborted) return;
      setPreview(undefined);
      setRecord("");
    } catch {
      if (!controller.signal.aborted) {
        setError(deadline.aborted ? "连接 Ling Server 超时，请检查网络后重试。"
          : "验证失败。请检查记录是否已发布到 Ling Server，以及服务器的地址和公钥指纹。");
      }
    } finally {
      pending.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const action = preview ? () => void confirm() : review;
  const actionDisabled = busy || !client || (!preview && !record.trim());
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {saved ? (
          <View style={styles.card} accessibilityLiveRegion="polite">
            <Text accessibilityRole="header" style={styles.heading}>已保存的服务器身份</Text>
            <Text selectable style={styles.value}>{saved.serverOrigin}</Text>
            <Text selectable style={styles.detail}>{saved.applicationKeyFingerprint}</Text>
            {transport ? <Text style={styles.detail}>
              {transport === "ling_server_webrtc" ? "已通过 Ling Server 建立 WebRTC 连接" : "已通过 PC 网关连接"}
            </Text> : null}
          </View>
        ) : null}
        {preview ? (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>确认服务器身份</Text>
            <Text style={styles.detail}>请与 PC 上的迁移预览核对以下信息。</Text>
            <Text style={styles.detail}>服务器地址</Text>
            <Text selectable style={styles.value}>{preview.routingProfile.serverOrigin}</Text>
            <Text style={styles.detail}>服务器公钥指纹</Text>
            <Text selectable style={styles.value}>{preview.routingProfile.applicationKeyFingerprint}</Text>
            <Text style={styles.detail}>绑定 ID</Text>
            <Text selectable style={styles.value}>{preview.routingProfile.bindingId}</Text>
            <Text style={styles.detail}>安装记录修订号 {preview.routingProfile.installationRevision}</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>迁移确认记录</Text>
            <Text style={styles.detail}>在 PC 确认迁移，并由 Ling Server 管理员发布后，粘贴导出的 JSON。</Text>
            <TextInput
              accessibilityLabel="迁移确认记录 JSON"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={MAX_MIGRATION_RECORD_LENGTH}
              multiline
              onChangeText={setRecord}
              placeholder="粘贴签名的迁移确认记录"
              placeholderTextColor={theme.text.muted}
              style={styles.input}
              value={record}
            />
          </View>
        )}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: actionDisabled }}
          disabled={actionDisabled}
          onPress={action}
          style={({ pressed }) => [styles.primary, (actionDisabled || pressed) && styles.dimmed]}
        >
          <Text style={styles.primaryLabel}>{busy ? "正在验证…" : preview ? "确认并验证" : "查看迁移详情"}</Text>
        </Pressable>
        {preview && !busy ? (
          <Pressable accessibilityRole="button" onPress={() => { setPreview(undefined); setError(undefined); }} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>返回编辑</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: MobileThemeTokens) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.app },
    content: { gap: 12, padding: 16 },
    card: { gap: 8, padding: 16, borderRadius: theme.radius.large, backgroundColor: theme.background.panel },
    heading: { color: theme.text.strong, fontSize: 17, fontWeight: "600" },
    detail: { color: theme.text.muted, fontSize: 14, lineHeight: 20 },
    value: { color: theme.text.default, fontSize: 15, lineHeight: 21 },
    input: {
      minHeight: 144, borderWidth: 1, borderColor: theme.border.default, borderRadius: theme.radius.medium, padding: 10,
      color: theme.text.default, fontSize: 14, textAlignVertical: "top",
    },
    error: { color: theme.status.danger, fontSize: 14, lineHeight: 20 },
    primary: { minHeight: 44, borderRadius: theme.radius.medium, alignItems: "center", justifyContent: "center", backgroundColor: theme.action.accent },
    primaryLabel: { color: theme.action.foreground, fontSize: 15, fontWeight: "600" },
    dimmed: { opacity: 0.65 },
    secondary: { minHeight: 44, alignItems: "center", justifyContent: "center" },
    secondaryLabel: { color: theme.text.default, fontSize: 15 },
  });
}
