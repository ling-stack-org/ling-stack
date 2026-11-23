import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";

import type { StandaloneDeviceRuntime } from "../../device/standalone-runtime";
import { isUsbAndroidLogTag, type AndroidApkSelection, type UsbAndroidDevice } from "../../device/usb-android";
import type {
  PhoneUsbAndroidDiagnosis, PhoneUsbAndroidInstall, PhoneUsbAndroidLogRun, PhoneUsbAndroidReview, PhoneUsbAndroidRuntime,
} from "../../device/usb-android-runtime";
import { discardLocalAndroidApk, pickLocalAndroidApk } from "../../platform/phone-task-artifact-file";
import { PhoneTaskCollaborationPanel } from "./PhoneTaskCollaborationPanel";

type PanelStyles = {
  readonly heading: TextStyle;
  readonly label: TextStyle;
  readonly note: TextStyle;
  readonly backText: TextStyle;
  readonly error: TextStyle;
  readonly row: ViewStyle;
  readonly field: ViewStyle;
  readonly input: TextStyle;
  readonly shareButton: ViewStyle;
  readonly action: ViewStyle;
  readonly actionText: TextStyle;
  readonly disabled: ViewStyle;
};

export function UsbAndroidPanel({ runtime, android, styles, renderTrace }: {
  readonly runtime: StandaloneDeviceRuntime;
  readonly android: PhoneUsbAndroidRuntime;
  readonly styles: PanelStyles;
  readonly renderTrace: (taskId: string) => ReactNode;
}) {
  const [targets, setTargets] = useState<readonly UsbAndroidDevice[]>([]);
  const [portId, setPortId] = useState<string>();
  const [diagnoses, setDiagnoses] = useState<readonly PhoneUsbAndroidDiagnosis[]>([]);
  const [diagnosisId, setDiagnosisId] = useState<string>();
  const [installs, setInstalls] = useState<readonly PhoneUsbAndroidInstall[]>([]);
  const [logs, setLogs] = useState<readonly PhoneUsbAndroidLogRun[]>([]);
  const [logTag, setLogTag] = useState("");
  const [expandedLogId, setExpandedLogId] = useState<string>();
  const [review, setReview] = useState<PhoneUsbAndroidReview>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const operation = useRef<AbortController | undefined>(undefined);
  const localApk = useRef<Extract<AndroidApkSelection, { source: "phone_file" }> | undefined>(undefined);
  const target = targets.find(item => item.portId === portId);
  const diagnosis = diagnoses.find(item => item.taskId === diagnosisId);

  useEffect(() => {
    let mounted = true;
    void Promise.all([android.listTargets(), android.listDiagnoses(), android.listInstalls(), android.listLogs()]).then(([ports, reads, writes, captures]) => {
      if (!mounted || operation.current) return;
      setTargets(ports);
      if (ports.length === 1) setPortId(ports[0]?.portId);
      setDiagnoses(reads);
      setDiagnosisId(reads[0]?.taskId);
      setInstalls(writes);
      setLogs(captures);
    }).catch(() => { if (mounted) setError("无法读取 USB 设备或手机上的安装记录。"); });
    return () => {
      mounted = false;
      operation.current?.abort();
      if (localApk.current) discardLocalAndroidApk(localApk.current);
    };
  }, [android]);

  async function perform(label: string, run: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(label);
    setError(undefined);
    try {
      await run(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(deviceErrorMessage(cause));
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  function clearReview() {
    if (localApk.current) {
      discardLocalAndroidApk(localApk.current);
      localApk.current = undefined;
    }
    setReview(undefined);
  }

  async function refresh(signal: AbortSignal) {
    const ports = await android.listTargets();
    if (signal.aborted) return;
    setTargets(ports);
    setPortId(previous => ports.some(item => item.portId === previous) ? previous : ports.length === 1 ? ports[0]?.portId : undefined);
  }

  async function selectApk(taskId: string, selection: AndroidApkSelection, signal: AbortSignal) {
    const prepared = await android.review(taskId, selection);
    if (!signal.aborted) setReview(prepared);
  }

  async function reloadInstalls(signal: AbortSignal) {
    const history = await android.listInstalls();
    if (!signal.aborted) setInstalls(history);
  }

  function confirm() {
    if (!target?.permissionGranted || !diagnosis || !review || diagnosis.taskId !== review.diagnosisTaskId || operation.current) return;
    Alert.alert("确认在外部设备安装 APK",
      [diagnosis.model || "Android", "目标 " + diagnosis.targetDeviceId.slice(-12), review.identity.packageId,
        "版本 " + review.identity.versionCode, review.digest].join("\n"),
      [
        { text: "取消", style: "cancel" },
        { text: "安装", onPress: () => void perform("正在安装并回读…", async signal => {
          const installed = await android.install({ target, review, signal });
          if (signal.aborted) return;
          setInstalls(previous => [installed, ...previous.filter(item => item.taskId !== installed.taskId)].slice(0, 8));
          clearReview();
        }) },
      ]);
  }

  function captureLogs() {
    const tag = logTag.trim();
    if (!target?.permissionGranted || !diagnosis || !isUsbAndroidLogTag(tag)) return;
    void perform("正在采集日志…", async signal => {
      const run = await android.captureLogs({ target, diagnosisTaskId: diagnosis.taskId, tag, signal });
      if (signal.aborted) return;
      setLogs(previous => [run, ...previous.filter(item => item.taskId !== run.taskId)].slice(0, 8));
      setExpandedLogId(run.taskId);
    });
  }

  function button(label: string, onPress: () => void, disabled = Boolean(busy), primary = false) {
    return <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
      style={[primary ? styles.action : styles.shareButton, disabled && styles.disabled]}>
      <Text style={primary ? styles.actionText : styles.backText}>{label}</Text>
    </Pressable>;
  }

  return <>
    <Text accessibilityRole="header" style={styles.heading}>Android USB 开发</Text>
    <Text style={styles.note}>用数据线连接 Android 设备或车机，在目标设备上开启 USB 调试并确认 Ling 的调试授权。</Text>
    {button("刷新 USB 设备", () => void perform("正在查找设备…", refresh))}
    {targets.length === 0 ? <Text style={styles.note}>未发现支持 USB 调试的 Android 设备。</Text> : null}
    {targets.map(item => (
      <View key={item.portId} style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: item.portId === portId, disabled: !!busy }}
          disabled={!!busy} style={styles.shareButton} onPress={() => { clearReview(); setPortId(item.portId); }}>
          <Text style={styles.label}>{item.label} · {item.vendorId.toString(16)}:{item.productId.toString(16)}{item.portId === portId ? " · 已选" : ""}</Text>
        </Pressable>
      </View>
    ))}
    {target && !target.permissionGranted ? button("授予 USB 权限", () => void perform("等待 USB 授权…", async signal => {
      await android.authorize(target);
      await refresh(signal);
    }), !!busy, true) : null}
    {target?.permissionGranted ? button("读取目标设备", () => void perform("等待目标确认调试授权…", async signal => {
      const read = await android.identify({ target, signal });
      if (signal.aborted) return;
      clearReview();
      setDiagnoses(previous => [read, ...previous.filter(item => item.taskId !== read.taskId)].slice(0, 8));
      setDiagnosisId(read.taskId);
    }), !!busy, true) : null}
    {diagnoses.length > 0 ? <View style={styles.field}>
      <Text accessibilityRole="header" style={styles.heading}>设备识别记录</Text>
      {diagnoses.map(item => (
        <Pressable key={item.taskId} accessibilityRole="button" accessibilityState={{ selected: item.taskId === diagnosisId, disabled: !!busy }}
          disabled={!!busy} style={[styles.row, styles.shareButton]} onPress={() => { clearReview(); setDiagnosisId(item.taskId); }}>
          <Text style={styles.label}>{item.model || "Android"} · Android {item.androidVersion}{item.taskId === diagnosisId ? " · 已选" : ""}</Text>
          <Text style={styles.note}>{item.targetDeviceId.slice(-12)} · {new Date(item.updatedAt).toLocaleString()}</Text>
        </Pressable>
      ))}
    </View> : null}
    {diagnosis ? <View style={styles.field}>
      {button("选择手机上的 APK", () => void perform("正在检查 APK…", async signal => {
        clearReview();
        const selection = await pickLocalAndroidApk(signal);
        if (!selection) return;
        if (signal.aborted) { discardLocalAndroidApk(selection); return; }
        localApk.current = selection;
        await selectApk(diagnosis.taskId, selection, signal);
      }))}
      <PhoneTaskCollaborationPanel key={diagnosis.taskId} runtime={runtime} taskId={diagnosis.taskId} updatedAt={diagnosis.updatedAt}
        styles={styles} selectApk={busy ? undefined : fileId => void perform("正在校验电脑提供的 APK…", async signal => {
          clearReview();
          await selectApk(diagnosis.taskId, { source: "paired_pc", fileId }, signal);
        })} />
    </View> : null}
    {diagnosis && target?.permissionGranted ? <View style={styles.field}>
      <Text style={styles.label}>应用日志标签</Text>
      <TextInput accessibilityLabel="应用日志标签" style={styles.input} value={logTag} onChangeText={setLogTag}
        autoCapitalize="none" autoCorrect={false} maxLength={120} editable={!busy} />
      {button("采集应用日志", captureLogs, Boolean(busy) || !isUsbAndroidLogTag(logTag.trim()))}
    </View> : null}
    {review ? <View style={styles.row}>
      <Text style={styles.label}>{review.fileName}</Text>
      <Text selectable style={styles.note}>{review.identity.packageId} · 版本 {review.identity.versionCode}</Text>
      <Text selectable style={styles.note}>{review.digest}</Text>
      <Text selectable style={styles.note}>签名证书 SHA-256{"\n"}{review.identity.signerCertificateSha256.join("\n")}</Text>
      {button("确认安装到目标设备", confirm, !!busy || target?.permissionGranted !== true, true)}
      {button("取消安装", clearReview)}
    </View> : null}
    {busy ? <Text accessibilityLiveRegion="polite" style={styles.note}>{busy}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {installs.length > 0 ? <View style={styles.field}>
      <Text accessibilityRole="header" style={styles.heading}>手机上的安装记录</Text>
      {installs.map(run => (
        <View key={run.taskId} style={styles.row}>
          <Text style={styles.label}>{run.packageId} · 版本 {run.versionCode}</Text>
          <Text style={styles.note}>{installStatus(run)} · 目标 {run.targetDeviceId.slice(-12)}</Text>
          {run.installedVersionCode && run.installedVersionCode !== run.versionCode
            ? <Text style={styles.note}>设备当前版本 {run.installedVersionCode}</Text> : null}
          {run.installedDigest ? <Text selectable style={styles.note}>{run.installedDigest}</Text> : null}
          {run.status === "unknown" && target ? button("回读这次安装结果", () => void perform("正在回读已安装的 APK…", async signal => {
            await android.readback({ target, taskId: run.taskId, signal });
            await reloadInstalls(signal);
          }), !!busy || !target.permissionGranted) : null}
          {renderTrace(run.taskId)}
          <PhoneTaskCollaborationPanel runtime={runtime} taskId={run.taskId} updatedAt={run.updatedAt} styles={styles} />
        </View>
      ))}
    </View> : null}
    {logs.length > 0 ? <View style={styles.field}>
      <Text accessibilityRole="header" style={styles.heading}>手机上的应用日志</Text>
      {logs.map(run => <View key={run.taskId} style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: expandedLogId === run.taskId }}
          onPress={() => setExpandedLogId(previous => previous === run.taskId ? undefined : run.taskId)} style={styles.shareButton}>
          <Text style={styles.label}>{run.tag} · {run.targetDeviceId.slice(-12)}</Text>
          <Text style={styles.note}>{new Date(run.updatedAt).toLocaleString()}</Text>
        </Pressable>
        {expandedLogId === run.taskId ? <>
          <Text selectable style={styles.note}>{run.text || (run.status === "succeeded" ? "本次采集没有匹配的日志。" : "本次采集未完成。")}</Text>
          {renderTrace(run.taskId)}
        </> : null}
      </View>)}
    </View> : null}
  </>;
}

function installStatus(run: PhoneUsbAndroidInstall): string {
  if (run.status === "succeeded") return "已安装并核验";
  if (run.status === "unknown") return "安装结果待回读";
  if (run.status === "failed") return "安装失败或回读与所选 APK 不符";
  if (run.status === "cancelled") return "安装已取消";
  return "安装记录待恢复";
}

function deviceErrorMessage(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  if (/usb_permission_denied|adb_authorization_required/u.test(code)) return "请确认手机的 USB 权限和目标设备上的调试授权。";
  if (/usb_target_changed|adb_target_identity_unavailable/u.test(code)) return "无法确认记录中的设备，请重新连接并读取目标。";
  if (/adb_invalid_apk|apk_archive_|phone_task_apk_|phone_task_artifact_digest/u.test(code)) return "APK 校验失败，请选择签名有效的完整 APK。";
  if (code.includes("phone_task_artifact_binding_changed")) return "APK 与所选设备记录不匹配，请重新选择文件。";
  if (code.includes("adb_install_pending_readback")) return "请先回读这台设备上待确认的安装记录。";
  if (code.includes("usb_android_backgrounded")) return "请在 Ling 前台确认并操作设备。";
  return "USB 操作未完成，请检查设备连接和调试权限。";
}
