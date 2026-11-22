import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { HomeAssistantInputError } from "../../device/home-assistant";
import { LinuxSshInputError, type LinuxSshTarget } from "../../device/linux-ssh";
import { useStandaloneDeviceRuntime } from "../../device/StandaloneDeviceProvider";
import type { PhoneHomeAssistantRun, PhoneLinuxSshRun, StandaloneDeviceRuntime } from "../../device/standalone-runtime";
import type { MobileThemeTokens } from "../../theme/mobile-theme";
import { useMobileTheme } from "../../theme/mobile-theme-provider";

export function StandaloneDeviceScreen({ onClose }: { readonly onClose?: () => void }) {
  const state = useStandaloneDeviceRuntime();
  const { theme } = useMobileTheme();
  const styles = createStyles(theme);
  const [selected, setSelected] = useState<"home" | "linux">("home");
  const [origin, setOrigin] = useState("");
  const [entityId, setEntityId] = useState("");
  const [token, setToken] = useState("");
  const [running, setRunning] = useState<PhoneHomeAssistantRun["operation"]>();
  const [automationTaskId, setAutomationTaskId] = useState<string>();
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

  const runHomeAssistant = async (diagnosisTaskId?: string) => {
    if (state.status !== "ready" || activeRun.current) return;
    const controller = new AbortController();
    activeRun.current = controller;
    setRunning(diagnosisTaskId ? "enable_automation" : "diagnosis");
    setAutomationTaskId(undefined);
    setError(undefined);
    const input = { origin, entityId, token, signal: controller.signal };
    try {
      const result = diagnosisTaskId
        ? await state.runtime.enableHomeAssistantAutomation({ ...input, diagnosisTaskId })
        : await state.runtime.diagnoseHomeAssistant(input);
      if (!controller.signal.aborted) {
        if (!diagnosisTaskId && result.taskStatus === "succeeded" && result.canEnableAutomation) setAutomationTaskId(result.taskId);
        else setToken("");
        setRuns(previous => [result, ...previous.filter(run => run.taskId !== result.taskId)].slice(0, 8));
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (diagnosisTaskId) setToken("");
        setError(cause instanceof HomeAssistantInputError ? cause.message : "设备操作中断，请在前台读取状态。");
      }
    } finally {
      activeRun.current = undefined;
      if (!controller.signal.aborted) setRunning(undefined);
    }
  };
  const canDiagnose = state.status === "ready" && !running && !!(origin.trim() && entityId.trim() && token.trim());
  const confirmAutomation = () => {
    if (!canDiagnose || !automationTaskId) return;
    Alert.alert("重新启用自动化", `${origin.trim()}\n${entityId.trim()}\n\n启用后，现有触发条件会恢复运行。`, [
      { text: "取消", style: "cancel" },
      { text: "重新启用", onPress: () => void runHomeAssistant(automationTaskId) },
    ]);
  };

  return (
    <SafeAreaView edges={onClose ? ["top", "bottom"] : ["bottom"]} style={styles.screen}>
      {onClose ? (
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.backButton}><Text style={styles.backText}>返回</Text></Pressable>
          <Text accessibilityRole="header" style={styles.heading}>手机设备诊断</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {state.status === "ready" && state.runtime.linuxSshAvailable ? (
          <View style={styles.selector}>
            {([["home", "Home Assistant"], ["linux", "Linux SSH"]] as const).map(([id, label]) => (
              <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: selected === id }}
                disabled={!!running} onPress={() => setSelected(id)} style={[styles.option, selected === id && styles.selectedOption]}>
                <Text style={styles.label}>{label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {selected === "linux" && state.status === "ready" && state.runtime.linuxSshAvailable ? (
          <LinuxSshPanel runtime={state.runtime} styles={styles} />
        ) : <>
        <Text accessibilityRole="header" style={styles.heading}>Home Assistant</Text>
        <Text style={styles.note}>手机会连接你填写的 Home Assistant 地址，读取指定实体的状态。</Text>
        <View style={styles.field}>
          <Text style={styles.label}>HTTPS 地址</Text>
          <TextInput accessibilityLabel="Home Assistant HTTPS 地址" autoCapitalize="none" autoCorrect={false} editable={!running}
            keyboardType="url" maxLength={512} onChangeText={value => { setOrigin(value); setAutomationTaskId(undefined); }} placeholder="https://home.example.com"
            placeholderTextColor={theme.text.soft} style={styles.input} value={origin} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>实体 ID</Text>
          <TextInput accessibilityLabel="Home Assistant 实体 ID" autoCapitalize="none" autoCorrect={false} editable={!running}
            maxLength={160} onChangeText={value => { setEntityId(value); setAutomationTaskId(undefined); }} placeholder="light.living_room"
            placeholderTextColor={theme.text.soft} style={styles.input} value={entityId} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>访问令牌</Text>
          <TextInput accessibilityLabel="Home Assistant 访问令牌" autoCapitalize="none" autoComplete="off" autoCorrect={false}
            editable={!running} maxLength={8192} onChangeText={setToken} secureTextEntry style={styles.input} value={token} />
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canDiagnose, busy: running === "diagnosis" }}
          disabled={!canDiagnose} onPress={() => void runHomeAssistant()} style={[styles.action, !canDiagnose && styles.disabled]}>
          <Text style={styles.actionText}>{running === "diagnosis" ? "正在读取…" : "读取设备状态"}</Text>
        </Pressable>
        {(automationTaskId && canDiagnose) || running === "enable_automation" ? (
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canDiagnose, busy: !!running }}
            disabled={!canDiagnose} onPress={confirmAutomation} style={[styles.action, !canDiagnose && styles.disabled]}>
            <Text style={styles.actionText}>{running ? "正在启用并验证…" : "重新启用自动化"}</Text>
          </Pressable>
        ) : null}
        {state.status === "unavailable" || error ? (
          <Text accessibilityRole="alert" style={styles.error}>{error ?? "手机设备诊断暂不可用，请重新打开 Ling。"}</Text>
        ) : null}
        {runs.length > 0 ? (
          <View style={styles.history}>
            <Text accessibilityRole="header" style={styles.heading}>手机上的设备记录</Text>
            {runs.map(run => (
              <View key={run.taskId} style={styles.row}>
                <Text style={styles.label}>{run.entityId}</Text>
                <Text style={styles.note}>{resultText(run)}</Text>
                <Text style={styles.note}>{new Date(run.updatedAt).toLocaleString()}</Text>
                {state.status === "ready" ? <DeviceTraceShareButton runtime={state.runtime} taskId={run.taskId} styles={styles} /> : null}
              </View>
            ))}
          </View>
        ) : null}
        </>}
      </ScrollView>
    </SafeAreaView>
  );
}

function LinuxSshPanel({ runtime, styles }: { readonly runtime: StandaloneDeviceRuntime; readonly styles: ReturnType<typeof createStyles> }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [dns, setDns] = useState("");
  const [password, setPassword] = useState("");
  const [targets, setTargets] = useState<readonly LinuxSshTarget[]>([]);
  const [runs, setRuns] = useState<readonly PhoneLinuxSshRun[]>([]);
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void Promise.all([runtime.listLinuxSshTargets(), runtime.listLinuxSshRuns()]).then(([saved, history]) => {
      if (current) { setTargets(saved); setRuns(history); }
    }).catch(() => { if (current) setError("无法读取手机上的 Linux 设备记录。"); });
    return () => { current = false; active.current?.abort(); };
  }, [runtime]);

  function selectTarget(target: LinuxSshTarget) {
    setHost(target.host);
    setPort(String(target.port));
    setUsername(target.username);
    setFingerprint(target.fingerprint);
    setDns(target.dnsProbeHostname ?? "");
    setPassword("");
  }

  async function diagnose() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setError(undefined);
    setPassword("");
    try {
      const run = await runtime.diagnoseLinuxSsh({
        target: { host, port: Number(port), username, fingerprint, dnsProbeHostname: dns },
        password, signal: controller.signal,
      });
      const saved = await runtime.listLinuxSshTargets();
      if (!controller.signal.aborted) {
        setRuns(previous => [run, ...previous.filter(item => item.taskId !== run.taskId)].slice(0, 8));
        setTargets(saved);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof LinuxSshInputError ? cause.message : "无法运行 Linux SSH 诊断。");
    } finally {
      active.current = undefined;
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  const canDiagnose = !running && !!(host.trim() && port.trim() && username.trim() && fingerprint.trim() && password);
  return <>
    {targets.map(target => (
      <Pressable key={target.deviceId} accessibilityRole="button" disabled={running}
        onPress={() => selectTarget(target)} style={styles.option}>
        <Text style={styles.label}>{target.host}</Text>
        <Text style={styles.note}>{target.username + " · " + target.port}</Text>
      </Pressable>
    ))}
    {([
      ["IP 地址或主机名", host, setHost, 253],
      ["SSH 端口", port, setPort, 5],
      ["SSH 用户名", username, setUsername, 64],
      ["已核验的 SHA256 主机指纹", fingerprint, setFingerprint, 64],
      ["DNS 测试域名（可选）", dns, setDns, 253],
    ] as const).map(([label, value, onChangeText, maxLength]) => (
      <View key={label} style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} editable={!running}
          keyboardType={label === "SSH 端口" ? "number-pad" : "default"} maxLength={maxLength}
          style={styles.input} value={value} onChangeText={onChangeText} />
      </View>
    ))}
    <View style={styles.field}>
      <Text style={styles.label}>SSH 密码</Text>
      <TextInput accessibilityLabel="SSH 密码" autoComplete="off" autoCapitalize="none" autoCorrect={false}
        editable={!running} maxLength={1024} secureTextEntry style={styles.input} value={password} onChangeText={setPassword} />
    </View>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canDiagnose, busy: running }}
      disabled={!canDiagnose} onPress={() => void diagnose()} style={[styles.action, !canDiagnose && styles.disabled]}>
      <Text style={styles.actionText}>{running ? "正在诊断…" : "连接并诊断"}</Text>
    </Pressable>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {runs.map(run => <View key={run.taskId} style={styles.row}>
      <Text style={styles.label}>{targets.find(target => target.deviceId === run.deviceId)?.host ?? "Linux SSH"}</Text>
      <Text style={styles.note}>{linuxResultText(run)}</Text>
      <Text style={styles.note}>{new Date(run.updatedAt).toLocaleString()}</Text>
      <DeviceTraceShareButton runtime={runtime} taskId={run.taskId} styles={styles} />
    </View>)}
  </>;
}

function DeviceTraceShareButton({ runtime, taskId, styles }: {
  readonly runtime: StandaloneDeviceRuntime;
  readonly taskId: string;
  readonly styles: ReturnType<typeof createStyles>;
}) {
  const active = useRef(false);
  async function share() {
    if (active.current) return;
    active.current = true;
    try {
      const trace = await runtime.readTaskTrace(taskId);
      if (!trace) throw new Error("mobile_device_task_unavailable");
      await Share.share({ message: JSON.stringify(trace, null, 2) });
    } catch {
      Alert.alert("无法分享诊断记录");
    } finally {
      active.current = false;
    }
  }
  return (
    <Pressable accessibilityRole="button" onPress={() => void share()} style={styles.shareButton}>
      <Text style={styles.backText}>分享执行记录</Text>
    </Pressable>
  );
}

function linuxResultText(run: PhoneLinuxSshRun): string {
  if (run.taskStatus === "unknown") return "诊断中断，设备状态待确认";
  if (run.errorCode === "target_changed") return "SSH 主机指纹不匹配";
  if (run.errorCode === "permission_denied") return "SSH 认证被拒绝";
  if (run.errorCode === "timeout") return "SSH 诊断超时";
  if (run.errorCode === "unsupported_capability") return "设备未提供所需的 Linux 诊断能力";
  if (!run.facts) return "未能读取网络状态";
  const { connected, routeAvailable, wifiAssociated, dnsNameResolved } = run.facts;
  return [
    connected ? "有 IPv4 地址" : "未发现 IPv4 地址",
    routeAvailable === undefined ? "路由待确认" : routeAvailable ? "已找到 IPv4 路由" : "无 IPv4 路由",
    wifiAssociated === undefined ? "Wi‑Fi 状态待确认" : wifiAssociated ? "Wi‑Fi 已关联" : "Wi‑Fi 未关联",
    ...(dnsNameResolved === undefined ? [] : [dnsNameResolved ? "DNS 解析成功" : "DNS 解析未成功"]),
  ].join(" · ");
}

function resultText(run: PhoneHomeAssistantRun): string {
  if (run.operation === "enable_automation") {
    if (run.taskStatus === "unknown") return "恢复结果待确认，请读取自动化状态";
    if (run.taskStatus === "cancelled") return "恢复已取消";
    if (run.errorCode === "target_changed") return "自动化身份已更改，请重新读取状态";
    if (run.errorCode === "permission_denied") return "恢复授权已过期或权限不足";
    if (run.taskStatus === "succeeded" && run.automationEnabled) return "已验证自动化处于启用状态";
    if (run.automationEnabled === false) return "已读回状态，自动化仍处于停用状态";
    return "自动化恢复未完成，请读取当前状态";
  }
  if (run.taskStatus === "unknown") return "诊断中断，设备状态待确认";
  if (run.taskStatus === "cancelled") return "诊断已取消";
  if (run.errorCode === "permission_denied") return "访问令牌无效或权限不足";
  if (run.automationEnabled !== undefined) return run.automationEnabled ? "自动化已启用" : "自动化已停用";
  if (run.availability === "available") return "实体状态可用";
  if (run.availability === "unavailable") return "Home Assistant 报告实体状态不可用";
  if (run.availability === "absent") return "Home Assistant 找不到这个实体";
  return "未能读取设备状态，请检查地址和网络";
}

function createStyles(theme: MobileThemeTokens) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.app },
    content: { padding: 16, paddingBottom: 24, gap: 12 },
    selector: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    option: { minHeight: 44, justifyContent: "center", paddingHorizontal: 10, backgroundColor: theme.background.panel,
      borderColor: theme.border.default, borderWidth: 1, borderRadius: theme.radius.medium },
    selectedOption: { borderColor: theme.action.accent },
    header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16 },
    backButton: { minHeight: 44, justifyContent: "center" },
    shareButton: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center" },
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
