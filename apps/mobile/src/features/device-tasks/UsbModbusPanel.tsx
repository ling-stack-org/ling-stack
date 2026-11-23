import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Share, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";

import { mapUsbError, UsbModbusInputError, type UsbModbusPort, type UsbModbusReplay, type UsbModbusSettings } from "../../device/usb-modbus";
import type { PhoneUsbModbusRun, StandaloneDeviceRuntime } from "../../device/standalone-runtime";

interface PanelStyles {
  readonly field: ViewStyle;
  readonly selector: ViewStyle;
  readonly option: ViewStyle;
  readonly selectedOption: ViewStyle;
  readonly action: ViewStyle;
  readonly disabled: ViewStyle;
  readonly shareButton: ViewStyle;
  readonly row: ViewStyle;
  readonly label: TextStyle;
  readonly note: TextStyle;
  readonly backText: TextStyle;
  readonly actionText: TextStyle;
  readonly input: TextStyle;
  readonly error: TextStyle;
}

export function UsbModbusPanel({ runtime, styles, renderTaskActions }: {
  readonly runtime: StandaloneDeviceRuntime;
  readonly styles: PanelStyles;
  readonly renderTaskActions: (run: PhoneUsbModbusRun) => ReactNode;
}) {
  const [ports, setPorts] = useState<readonly UsbModbusPort[]>([]);
  const [portId, setPortId] = useState<string>();
  const [baud, setBaud] = useState("9600");
  const [unit, setUnit] = useState("1");
  const [start, setStart] = useState("0");
  const [count, setCount] = useState("1");
  const [table, setTable] = useState<UsbModbusSettings["table"]>("holding");
  const [parity, setParity] = useState<UsbModbusSettings["parity"]>("none");
  const [stopBits, setStopBits] = useState<UsbModbusSettings["stopBits"]>(1);
  const [runs, setRuns] = useState<readonly PhoneUsbModbusRun[]>([]);
  const [replay, setReplay] = useState<{ readonly taskId: string; readonly evidence: UsbModbusReplay }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const port = ports.find(item => item.portId === portId);

  useEffect(() => {
    let current = true;
    void Promise.all([runtime.listUsbModbusPorts(), runtime.listUsbModbusRuns()]).then(([devices, history]) => {
      if (current) {
        setPorts(devices);
        setRuns(history);
      }
    }).catch(() => { if (current) setError("无法读取 USB 串口或手机任务记录。"); });
    return () => {
      current = false;
      active.current?.abort();
    };
  }, [runtime]);

  async function perform(operation: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof UsbModbusInputError ? failure.message : usbErrorText(mapUsbError(failure)));
    } finally {
      if (active.current === controller) active.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function scan(signal: AbortSignal) {
    const devices = await runtime.listUsbModbusPorts();
    if (!signal.aborted) {
      setPorts(devices);
      setPortId(port && devices.some(device => device.portId === port.portId && device.vendorId === port.vendorId
        && device.productId === port.productId) ? port.portId : undefined);
    }
  }

  function submit() {
    if (!port) return;
    void perform(async signal => {
      if (!port.permissionGranted) {
        await runtime.authorizeUsbModbusPort(port);
        await scan(signal);
        return;
      }
      const run = await runtime.diagnoseUsbModbus({
        port, settings: {
          baudRate: parseNumber(baud), parity, stopBits, table, unitAddress: parseNumber(unit),
          startAddress: parseNumber(start), quantity: parseNumber(count),
        }, signal,
      });
      if (!signal.aborted) setRuns(previous => [run, ...previous.filter(item => item.taskId !== run.taskId)].slice(0, 8));
    });
  }

  return <>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void perform(scan)} style={styles.shareButton}>
      <Text style={styles.backText}>刷新 USB 串口</Text>
    </Pressable>
    {ports.length === 0 ? <Text style={styles.note}>请连接支持 USB Host 的手机与 USB 转 RS‑485 适配器。</Text> : null}
    {ports.map(item => <Pressable key={item.portId} accessibilityRole="button" disabled={busy}
      accessibilityState={{ selected: port === item }} onPress={() => setPortId(item.portId)}
      style={[styles.option, port === item && styles.selectedOption]}>
      <Text style={styles.label}>{item.label} · 串口 {item.portNumber + 1}</Text>
      <Text style={styles.note}>
        {usbId(item.vendorId)} · {usbId(item.productId)} · {item.permissionGranted ? "已授权" : "待授权"}
      </Text>
    </Pressable>)}
    {port?.permissionGranted ? <>
      {([
        ["波特率", baud, setBaud, 6], ["站号", unit, setUnit, 3],
        ["协议起始地址（从 0 开始）", start, setStart, 5], ["寄存器数量", count, setCount, 3],
      ] as const).map(([label, value, change, maxLength]) => <View key={label} style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput accessibilityLabel={label} editable={!busy} keyboardType="number-pad"
          maxLength={maxLength} value={value} onChangeText={change} style={styles.input} />
      </View>)}
      <Options label="寄存器类型" choices={[["holding", "保持寄存器"], ["input", "输入寄存器"]]}
        selected={table} choose={setTable} busy={busy} styles={styles} />
      <Options label="校验" choices={[["none", "无校验"], ["even", "偶校验"], ["odd", "奇校验"]]}
        selected={parity} choose={setParity} busy={busy} styles={styles} />
      <Options label="停止位" choices={[[1, "1 位"], [2, "2 位"]]}
        selected={stopBits} choose={setStopBits} busy={busy} styles={styles} />
    </> : null}
    {port ? <Pressable accessibilityRole="button" disabled={busy} onPress={submit}
      accessibilityState={{ busy, disabled: busy }} style={[styles.action, busy && styles.disabled]}>
      <Text style={styles.actionText}>{busy ? "正在处理…" : port.permissionGranted ? "读取寄存器" : "授权 USB 串口"}</Text>
    </Pressable> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {runs.map(run => <View key={run.taskId} style={styles.row}>
      <Text style={styles.label}>{resultText(run)}</Text>
      <Text style={styles.note}>{new Date(run.updatedAt).toLocaleString()}</Text>
      {run.outcome ? <Pressable accessibilityRole="button" disabled={busy} style={styles.shareButton}
        onPress={() => void perform(async signal => {
          const evidence = await runtime.replayUsbModbusCapture(run.taskId);
          if (signal.aborted) return;
          if (evidence) setReplay({ taskId: run.taskId, evidence });
          else setError("无法验证采集记录。");
        })}>
        <Text style={styles.backText}>回放串口帧</Text>
      </Pressable> : null}
      {replay?.taskId === run.taskId ? <>
        {replay.evidence.frames.map(frame => <Text selectable key={frame.sequence} style={styles.note}>
          {frame.direction.toUpperCase()} · {frame.checksumValid ? "CRC 正确" : "CRC 失败"}{"\n"}{frame.hex}
        </Text>)}
        <Pressable accessibilityRole="button" disabled={busy} style={styles.shareButton} onPress={() => void perform(async signal => {
          try {
            await Share.share({ title: "Modbus RTU 串口采集", message: JSON.stringify(replay.evidence.capture, null, 2) });
          } catch {
            if (!signal.aborted) setError("无法导出串口采集。");
          }
        })}>
          <Text style={styles.backText}>分享原始串口采集</Text>
        </Pressable>
      </> : null}
      {renderTaskActions(run)}
    </View>)}
  </>;
}

function Options<Value extends string | number>({ label, choices, selected, choose, busy, styles }: {
  readonly label: string;
  readonly choices: readonly (readonly [Value, string])[];
  readonly selected: Value;
  readonly choose: (value: Value) => void;
  readonly busy: boolean;
  readonly styles: PanelStyles;
}) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.selector}>
      {choices.map(([value, text]) => <Pressable key={value} accessibilityRole="button"
        accessibilityState={{ selected: value === selected }} disabled={busy} onPress={() => choose(value)}
        style={[styles.option, value === selected && styles.selectedOption]}>
        <Text style={styles.label}>{text}</Text>
      </Pressable>)}
    </View>
  </View>;
}

function parseNumber(value: string): number {
  return /^\d+$/u.test(value) ? Number(value) : NaN;
}

function usbId(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function usbErrorText(code: PhoneUsbModbusRun["errorCode"]): string {
  if (code === "permission_denied") return "USB 串口权限未授予。";
  if (code === "missing_target" || code === "target_changed") return "USB 串口已断开或发生变化，请刷新并重新选择。";
  if (code === "target_busy") return "USB 串口正在使用。";
  return "USB 串口读取失败，请检查连接。";
}

function resultText(run: PhoneUsbModbusRun): string {
  if (run.taskStatus === "unknown") return "读取已中断，未取得结果。";
  if (run.taskStatus === "cancelled") return "读取已取消。";
  const { outcome } = run;
  if (!outcome) return run.taskStatus === "succeeded" ? "无法验证采集记录。" : usbErrorText(run.errorCode);
  if (outcome.status === "read") return "站号 " + outcome.unitAddress + " · 地址 " + outcome.startAddress + " · " + outcome.registers.join(", ");
  if (outcome.status === "invalid_checksum") return "设备响应的 CRC 校验失败。";
  if (outcome.status === "device_exception") return "设备返回 Modbus 异常。";
  if (outcome.status === "mismatched_response") return "响应与请求的站号、功能或数量不符。";
  return "未收到完整响应，请检查串口参数和接线。";
}
