import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { HomeAssistantInputError } from "../../device/home-assistant";
import { useStandaloneDeviceRuntime } from "../../device/StandaloneDeviceProvider";
import type { PhoneHomeAssistantRun } from "../../device/standalone-runtime";
import type { MobileThemeTokens } from "../../theme/mobile-theme";
import { useMobileTheme } from "../../theme/mobile-theme-provider";

export function StandaloneDeviceScreen({ onClose }: { readonly onClose?: () => void }) {
  const state = useStandaloneDeviceRuntime();
  const { theme } = useMobileTheme();
  const styles = createStyles(theme);
  const [origin, setOrigin] = useState("");
  const [entityId, setEntityId] = useState("");
  const [token, setToken] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [runs, setRuns] = useState<readonly PhoneHomeAssistantRun[]>([]);
  const activeRun = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (state.status !== "ready") return;
    let current = true;
    void state.runtime.listHomeAssistantRuns().then(result => {
      if (current) setRuns(result);
    }).catch(() => {
      if (current) setError("手机上的设备记录读取失败。");
    });
    return () => { current = false; };
  }, [state]);

  useEffect(() => () => { activeRun.current?.abort(); }, []);

  const diagnose = async () => {
    if (state.status !== "ready" || activeRun.current) return;
    const controller = new AbortController();
    activeRun.current = controller;
    setRunning(true);
    setError(undefined);
    try {
      const result = await state.runtime.diagnoseHomeAssistant({ origin, entityId, token, signal: controller.signal });
      if (!controller.signal.aborted) {
        setToken("");
        setRuns(previous => [result, ...previous.filter(run => run.taskId !== result.taskId)].slice(0, 8));
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof HomeAssistantInputError ? cause.message : "无法运行诊断，请回到前台后重试。");
    } finally {
      activeRun.current = undefined;
      if (!controller.signal.aborted) setRunning(false);
    }
  };
  const canDiagnose = state.status === "ready" && !running && !!(origin.trim() && entityId.trim() && token.trim());

  return (
    <SafeAreaView edges={onClose ? ["top", "bottom"] : ["bottom"]} style={styles.screen}>
      {onClose ? (
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.backButton}><Text style={styles.backText}>返回</Text></Pressable>
          <Text accessibilityRole="header" style={styles.heading}>手机设备诊断</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.heading}>Home Assistant</Text>
        <Text style={styles.note}>手机会连接你填写的 Home Assistant 地址，读取指定实体的状态。</Text>
        <View style={styles.field}>
          <Text style={styles.label}>HTTPS 地址</Text>
          <TextInput accessibilityLabel="Home Assistant HTTPS 地址" autoCapitalize="none" autoCorrect={false} editable={!running}
            keyboardType="url" maxLength={512} onChangeText={setOrigin} placeholder="https://home.example.com"
            placeholderTextColor={theme.text.soft} style={styles.input} value={origin} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>实体 ID</Text>
          <TextInput accessibilityLabel="Home Assistant 实体 ID" autoCapitalize="none" autoCorrect={false} editable={!running}
            maxLength={160} onChangeText={setEntityId} placeholder="light.living_room"
            placeholderTextColor={theme.text.soft} style={styles.input} value={entityId} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>访问令牌</Text>
          <TextInput accessibilityLabel="Home Assistant 访问令牌" autoCapitalize="none" autoComplete="off" autoCorrect={false}
            editable={!running} maxLength={8192} onChangeText={setToken} secureTextEntry style={styles.input} value={token} />
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canDiagnose, busy: running }}
          disabled={!canDiagnose} onPress={() => void diagnose()} style={[styles.action, !canDiagnose && styles.disabled]}>
          <Text style={styles.actionText}>{running ? "正在读取…" : "读取设备状态"}</Text>
        </Pressable>
        {state.status === "unavailable" || error ? (
          <Text accessibilityRole="alert" style={styles.error}>{error ?? "手机设备诊断暂不可用，请重新打开 Ling。"}</Text>
        ) : null}
        {runs.length > 0 ? (
          <View style={styles.history}>
            <Text accessibilityRole="header" style={styles.heading}>手机上的诊断记录</Text>
            {runs.map(run => (
              <View key={run.taskId} style={styles.row}>
                <Text style={styles.label}>{run.entityId}</Text>
                <Text style={styles.note}>{resultText(run)}</Text>
                <Text style={styles.note}>{new Date(run.updatedAt).toLocaleString()}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function resultText(run: PhoneHomeAssistantRun): string {
  if (run.taskStatus === "unknown") return "诊断中断，设备状态待确认";
  if (run.taskStatus === "cancelled") return "诊断已取消";
  if (run.errorCode === "permission_denied") return "访问令牌无效或权限不足";
  if (run.availability === "available") return "实体状态可用";
  if (run.availability === "unavailable") return "Home Assistant 报告实体状态不可用";
  if (run.availability === "absent") return "Home Assistant 找不到这个实体";
  return "未能读取设备状态，请检查地址和网络";
}

function createStyles(theme: MobileThemeTokens) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.app },
    content: { padding: 16, paddingBottom: 24, gap: 12 },
    header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16 },
    backButton: { minHeight: 44, justifyContent: "center" },
    backText: { color: theme.text.default, fontSize: 15 },
    heading: { color: theme.text.strong, fontSize: 18, fontWeight: "600" },
    label: { color: theme.text.strong, fontSize: 14, fontWeight: "600" },
    note: { color: theme.text.muted, fontSize: 13, lineHeight: 19 },
    field: { gap: 6 },
    input: { minHeight: 44, paddingHorizontal: 12, color: theme.text.default, backgroundColor: theme.background.panel,
      borderColor: theme.border.default, borderWidth: 1, borderRadius: theme.radius.medium },
    action: { minHeight: 44, alignItems: "center", justifyContent: "center", backgroundColor: theme.action.accent, borderRadius: theme.radius.medium },
    actionText: { color: theme.action.foreground, fontWeight: "600" },
    disabled: { opacity: 0.5 },
    error: { color: theme.status.danger, fontSize: 13, lineHeight: 19 },
    history: { marginTop: 8, gap: 8 },
    row: { padding: 12, gap: 4, backgroundColor: theme.background.panel, borderRadius: theme.radius.large },
  });
}
