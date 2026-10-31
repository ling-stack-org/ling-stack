import Foundation
import Virtualization
import Darwin

// Standalone research executable; not a Ling Runner or a production capability.
struct Inputs: Decodable {
    let kernel: String
    let ramdisk: String
    let input: String
    let output: String
    let mode: String
}

final class Probe: NSObject, VZVirtualMachineDelegate {
    let inputs: Inputs
    let started = DispatchTime.now().uptimeNanoseconds
    var vm: VZVirtualMachine!
    var outputPipe = Pipe()
    var inputPipe = Pipe()
    var timeout: DispatchWorkItem?
    var stopping = false
    var ready = false
    var resultSeen = false
    var consoleBytes = 0
    var consoleTail = Data()

    init(_ inputs: Inputs) { self.inputs = inputs }

    func emit(_ event: String, _ extra: [String: Any] = [:]) {
        var row = extra
        row["event"] = event
        row["elapsedMs"] = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
    }

    func start() throws {
        guard VZVirtualMachine.isSupported, ["verify", "cancel"].contains(inputs.mode) else {
            throw NSError(domain: "unsupported_vm_probe", code: 1)
        }
        let config = VZVirtualMachineConfiguration()
        let loader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: inputs.kernel))
        loader.initialRamdiskURL = URL(fileURLWithPath: inputs.ramdisk)
        loader.commandLine = "console=hvc0 rdinit=/ling-init panic=0 loglevel=3 ling_mode=\(inputs.mode)"
        config.bootLoader = loader
        config.cpuCount = 1
        config.memorySize = 512 * 1024 * 1024
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        // No NAT, bridge, disk or socket device. The two explicit shares are
        // the only host filesystem surfaces exposed to this guest.
        config.networkDevices = []
        config.storageDevices = []
        config.socketDevices = []
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: inputPipe.fileHandleForReading,
            fileHandleForWriting: outputPipe.fileHandleForWriting)
        config.serialPorts = [serial]
        let source = VZVirtioFileSystemDeviceConfiguration(tag: "ling-input")
        source.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: inputs.input), readOnly: true))
        let output = VZVirtioFileSystemDeviceConfiguration(tag: "ling-output")
        output.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: inputs.output), readOnly: false))
        config.directorySharingDevices = [source, output]
        try config.validate()
        vm = VZVirtualMachine(configuration: config)
        vm.delegate = self
        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.received(bytes) }
        }
        let deadline = DispatchWorkItem { [weak self] in self?.stop("deadline", exitCode: 2) }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: deadline)
        emit("starting", ["memoryBytes": config.memorySize, "cpus": config.cpuCount, "networkDevices": 0])
        vm.start { [weak self] result in
            switch result {
            case .success: self?.emit("started")
            case .failure(let error): self?.finish("start_failed", error.localizedDescription, exitCode: 1)
            }
        }
    }

    func received(_ bytes: Data) {
        consoleBytes += bytes.count
        consoleTail.append(bytes)
        if consoleTail.count > 64 * 1024 { consoleTail.removeFirst(consoleTail.count - 64 * 1024) }
        if consoleBytes > 2 * 1024 * 1024 { stop("console_limit", exitCode: 2); return }
        let text = String(decoding: consoleTail, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
        if !ready && text.contains("LING_VM_READY") {
            ready = true
            emit("guest_ready")
            if inputs.mode == "cancel" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.stop("cancelled", exitCode: 0) }
            }
        }
        if !resultSeen, let range = text.range(of: "LING_VM_RESULT "),
           let end = text[range.upperBound...].firstIndex(of: "\n") {
            resultSeen = true
            let json = String(text[range.upperBound..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            emit("guest_result", ["result": json])
            inputPipe.fileHandleForWriting.write(Data("ACK\n".utf8))
        }
    }

    func stop(_ reason: String, exitCode: Int32) {
        guard !stopping else { return }
        stopping = true
        emit("stop_requested", ["reason": reason])
        vm.stop { error in
            if let error { self.finish("stop_failed", error.localizedDescription, exitCode: 1) }
            else { self.finish("stopped", reason, exitCode: exitCode) }
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        finish("guest_stopped", "poweroff", exitCode: resultSeen ? 0 : 1)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        finish("guest_failed", error.localizedDescription, exitCode: 1)
    }

    func finish(_ event: String, _ reason: String, exitCode: Int32) {
        timeout?.cancel()
        outputPipe.fileHandleForReading.readabilityHandler = nil
        emit(event, ["reason": reason, "state": vm?.state.rawValue ?? -1, "consoleBytes": consoleBytes])
        if exitCode != 0 { FileHandle.standardError.write(consoleTail) }
        exit(exitCode)
    }
}

guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--run-isolated-probe" else {
    fputs("VM experiment disabled; explicit isolated probe flag and input file required.\n", stderr)
    exit(64)
}
do {
    let inputs = try JSONDecoder().decode(Inputs.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
    let probe = Probe(inputs)
    try probe.start()
    withExtendedLifetime(probe) { RunLoop.main.run() }
} catch {
    fputs("VM probe failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
