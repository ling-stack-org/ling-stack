import AppKit
import CoreServices
import Darwin
import Foundation

let protocolVersion = "ling.office.driver.v1"
let helperVersion = "0.1.0"
let excelBundleIdentifier = "com.microsoft.Excel"
let maximumFrameBytes = 4 * 1024 * 1024
let maximumResultBytes = 8 * 1024 * 1024

struct OfficeFailure: Error {
    let code: String
}

struct WorkbookSession {
    let id: String
    let name: String
    let path: String
    let activeSheet: String
    let readOnly: Bool
    let dirty: Bool
    let fileRevision: String
}

final class OfficeDriver {
    private var sessions: [String: WorkbookSession] = [:]
    private var completed: [String: [String: Any]] = [:]
    private var completedOrder: [String] = []
    private var recovered: Set<String> = []
    private var externallyChanged: Set<String> = []

    func handle(_ request: [String: Any]) -> [String: Any] {
        let allowedKeys: Set<String> = ["protocol", "id", "method", "params", "deadlineAt", "idempotencyKey"]
        guard Set(request.keys) == allowedKeys,
              request["protocol"] as? String == protocolVersion,
              let id = boundedString(request["id"], max: 128),
              let method = boundedString(request["method"], max: 64),
              let idempotencyKey = boundedString(request["idempotencyKey"], max: 256),
              let deadline = boundedString(request["deadlineAt"], max: 64),
              let params = request["params"] as? [String: Any],
              !deadlineExpired(deadline) else {
            return failure(id: request["id"] as? String ?? "invalid", code: "office_driver_request_invalid")
        }
        if let cached = completed[idempotencyKey] {
            var replay = cached
            replay["id"] = id
            return replay
        }
        do {
            let result = try execute(method: method, params: params, idempotencyKey: idempotencyKey)
            let response = success(id: id, result: result)
            cache(response, for: idempotencyKey)
            return response
        } catch let error as OfficeFailure {
            return failure(id: id, code: error.code)
        } catch {
            return failure(id: id, code: "office_driver_failed")
        }
    }

    private func execute(method: String, params: [String: Any], idempotencyKey: String) throws -> Any {
        if method == "driver_status" { return driverStatus() }
        try ensureExcelPermission(prompt: true)
        switch method {
        case "list_sessions":
            return try listSessions().map(sessionProjection)
        case "read_ranges":
            return try readRanges(params)
        case "search_workbook":
            return try searchWorkbook(params)
        case "write_range":
            return try mutate(params, idempotencyKey: idempotencyKey) { session in
                try self.writeRange(params, session: session)
            }
        case "update_sheet":
            return try mutate(params, idempotencyKey: idempotencyKey) { session in
                try self.updateSheet(params, session: session)
            }
        case "format_range":
            return try mutate(params, idempotencyKey: idempotencyKey) { session in
                try self.formatRange(params, session: session)
            }
        case "save_workbook":
            return try mutate(params, idempotencyKey: idempotencyKey) { session in
                _ = try self.runAppleScript("tell application id \"com.microsoft.Excel\" to save workbook \(quoted(session.name))")
                return ["sessionId": session.id, "saved": true]
            }
        case "save_workbook_as":
            return try mutate(params, idempotencyKey: idempotencyKey) { session in
                try self.saveWorkbookAs(params, session: session)
            }
        default:
            throw OfficeFailure(code: "office_driver_capability_unavailable")
        }
    }

    private func driverStatus() -> [String: Any] {
        let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: excelBundleIdentifier) != nil
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: excelBundleIdentifier).isEmpty == false
        let permission = running ? excelPermission(prompt: false) : false
        let state: String
        if !installed { state = "office_missing" }
        else if !running { state = "application_not_running" }
        else if !permission { state = "permission_required" }
        else { state = "limited" }
        return [
            "helperVersion": helperVersion,
            "state": state,
            "capabilities": installed ? [
                "excel:sessions", "excel:read", "excel:search", "excel:write",
                "excel:sheets", "excel:format-basic", "excel:save", "excel:save-as",
            ] : [],
            "officeInstalled": installed,
            "applicationRunning": running,
            "permissionGranted": permission,
        ]
    }

    private func listSessions(clearExternalChangeFences: Bool = true) throws -> [WorkbookSession] {
        let source = """
        tell application id "com.microsoft.Excel"
          set output to {}
          repeat with wb in workbooks
            set workbookPath to ""
            try
              set workbookPath to full name of wb as text
            end try
            set sheetName to ""
            try
              set sheetName to name of active sheet of wb as text
            end try
            set isReadOnly to false
            try
              set isReadOnly to read only of wb
            end try
            set isSaved to true
            try
              set isSaved to saved of wb
            end try
            set end of output to {name of wb as text, workbookPath, sheetName, isReadOnly, not isSaved}
          end repeat
          return output
        end tell
        """
        let raw = try runAppleScript(source) as? [Any] ?? []
        var next: [String: WorkbookSession] = [:]
        for item in raw {
            guard let fields = item as? [Any], fields.count >= 5,
                  let name = fields[0] as? String else { continue }
            let path = fields[1] as? String ?? ""
            let stable = path.isEmpty ? name : path
            let id = "excel-\(fnv1a64(stable))"
            let session = WorkbookSession(
                id: id,
                name: name,
                path: path,
                activeSheet: fields[2] as? String ?? "",
                readOnly: fields[3] as? Bool ?? false,
                dirty: fields[4] as? Bool ?? false,
                fileRevision: fileRevision(path)
            )
            next[id] = session
        }
        sessions = next
        if clearExternalChangeFences { externallyChanged.removeAll() }
        return next.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private func requireSession(_ params: [String: Any]) throws -> WorkbookSession {
        guard let sessionId = boundedString(params["sessionId"], max: 256) else {
            throw OfficeFailure(code: "office_driver_session_required")
        }
        if externallyChanged.contains(sessionId) {
            throw OfficeFailure(code: "office_driver_workbook_changed_externally")
        }
        let previous = sessions[sessionId]
        _ = try listSessions(clearExternalChangeFences: false)
        guard let session = sessions[sessionId] else { throw OfficeFailure(code: "office_driver_session_stale") }
        if let previous,
           !previous.fileRevision.isEmpty,
           !session.fileRevision.isEmpty,
           previous.fileRevision != session.fileRevision {
            externallyChanged.insert(sessionId)
            throw OfficeFailure(code: "office_driver_workbook_changed_externally")
        }
        return session
    }

    private func mutate(
        _ params: [String: Any],
        idempotencyKey: String,
        action: (WorkbookSession) throws -> Any
    ) throws -> Any {
        let session = try requireSession(params)
        try ensureRecovery(session, idempotencyKey: idempotencyKey)
        defer { _ = try? listSessions(clearExternalChangeFences: false) }
        return try action(session)
    }

    private func readRanges(_ params: [String: Any]) throws -> [String: Any] {
        let session = try requireSession(params)
        guard let ranges = params["ranges"] as? [String], !ranges.isEmpty, ranges.count <= 50 else {
            throw OfficeFailure(code: "office_driver_range_invalid")
        }
        let values = try ranges.map { range -> [String: Any] in
            let target = splitRange(range, defaultSheet: session.activeSheet)
            let script = """
            tell application id "com.microsoft.Excel"
              tell workbook \(quoted(session.name))
                tell worksheet \(quoted(target.sheet))
                  set targetRange to range \(quoted(target.address))
                  return {value of targetRange, formula of targetRange}
                end tell
              end tell
            end tell
            """
            let result = try runAppleScript(script) as? [Any] ?? []
            return [
                "range": range,
                "values": result.indices.contains(0) ? result[0] : NSNull(),
                "formulas": result.indices.contains(1) ? result[1] : NSNull(),
            ]
        }
        return ["sessionId": session.id, "ranges": values]
    }

    private func searchWorkbook(_ params: [String: Any]) throws -> [String: Any] {
        let session = try requireSession(params)
        guard let query = boundedString(params["query"], max: 512) else {
            throw OfficeFailure(code: "office_driver_query_invalid")
        }
        let maxResults = min(max(params["maxResults"] as? Int ?? 50, 1), 200)
        let source = """
        tell application id "com.microsoft.Excel"
          tell workbook \(quoted(session.name))
            set output to {}
            repeat with ws in worksheets
              set usedValues to value of used range of ws
              set end of output to {name of ws as text, usedValues}
            end repeat
            return output
          end tell
        end tell
        """
        let sheets = try runAppleScript(source) as? [Any] ?? []
        var matches: [[String: Any]] = []
        for item in sheets {
            guard let fields = item as? [Any], fields.count >= 2, let sheet = fields[0] as? String else { continue }
            let rows = normalizeRows(fields[1])
            for (rowIndex, row) in rows.enumerated() {
                for (columnIndex, value) in row.enumerated() where String(describing: value).localizedCaseInsensitiveContains(query) {
                    matches.append(["sheet": sheet, "row": rowIndex + 1, "column": columnIndex + 1, "value": value])
                    if matches.count >= maxResults { return ["sessionId": session.id, "matches": matches, "truncated": true] }
                }
            }
        }
        return ["sessionId": session.id, "matches": matches, "truncated": false]
    }

    private func writeRange(_ params: [String: Any], session: WorkbookSession) throws -> [String: Any] {
        guard let rawRange = boundedString(params["range"], max: 64) else {
            throw OfficeFailure(code: "office_driver_range_invalid")
        }
        let target = splitRange(rawRange, defaultSheet: session.activeSheet)
        let values = params["values"]
        let formulas = params["formulas"]
        guard values != nil || formulas != nil else { throw OfficeFailure(code: "office_driver_values_required") }
        let assignment = formulas != nil
            ? "set formula of targetRange to \(try appleScriptLiteral(formulas!))"
            : "set value of targetRange to \(try appleScriptLiteral(values!))"
        let source = """
        tell application id "com.microsoft.Excel"
          tell workbook \(quoted(session.name))
            tell worksheet \(quoted(target.sheet))
              set targetRange to range \(quoted(target.address))
              \(assignment)
            end tell
          end tell
        end tell
        """
        _ = try runAppleScript(source)
        return ["sessionId": session.id, "range": rawRange, "written": true]
    }

    private func updateSheet(_ params: [String: Any], session: WorkbookSession) throws -> [String: Any] {
        guard let action = params["action"] as? String else { throw OfficeFailure(code: "office_driver_sheet_action_invalid") }
        let source: String
        if action == "create", let name = boundedString(params["name"], max: 31) {
            source = "tell application id \"com.microsoft.Excel\" to make new worksheet at end of worksheets of workbook \(quoted(session.name)) with properties {name:\(quoted(name))}"
        } else if action == "rename", let sheet = boundedString(params["sheet"], max: 31), let name = boundedString(params["name"], max: 31) {
            source = "tell application id \"com.microsoft.Excel\" to set name of worksheet \(quoted(sheet)) of workbook \(quoted(session.name)) to \(quoted(name))"
        } else if action == "delete", let sheet = boundedString(params["sheet"], max: 31) {
            source = "tell application id \"com.microsoft.Excel\" to delete worksheet \(quoted(sheet)) of workbook \(quoted(session.name))"
        } else {
            throw OfficeFailure(code: "office_driver_sheet_action_invalid")
        }
        _ = try runAppleScript(source)
        return ["sessionId": session.id, "updated": true]
    }

    private func formatRange(_ params: [String: Any], session: WorkbookSession) throws -> [String: Any] {
        guard let rawRange = boundedString(params["range"], max: 64), let format = params["format"] as? [String: Any] else {
            throw OfficeFailure(code: "office_driver_format_invalid")
        }
        if format["fillColor"] != nil || format["fontColor"] != nil {
            throw OfficeFailure(code: "office_driver_format_color_unavailable")
        }
        let target = splitRange(rawRange, defaultSheet: session.activeSheet)
        var statements: [String] = []
        if let bold = format["bold"] as? Bool { statements.append("set bold of font object of targetRange to \(bold)") }
        if let italic = format["italic"] as? Bool { statements.append("set italic of font object of targetRange to \(italic)") }
        if let numberFormat = boundedString(format["numberFormat"], max: 128) {
            statements.append("set number format of targetRange to \(quoted(numberFormat))")
        }
        let source = """
        tell application id "com.microsoft.Excel"
          tell workbook \(quoted(session.name))
            tell worksheet \(quoted(target.sheet))
              set targetRange to range \(quoted(target.address))
              \(statements.joined(separator: "\n"))
            end tell
          end tell
        end tell
        """
        _ = try runAppleScript(source)
        return ["sessionId": session.id, "range": rawRange, "formatted": true]
    }

    private func saveWorkbookAs(_ params: [String: Any], session: WorkbookSession) throws -> [String: Any] {
        guard let path = boundedString(params["path"], max: 4096), path.hasSuffix(".xlsx"), path.hasPrefix("/") else {
            throw OfficeFailure(code: "office_driver_save_path_invalid")
        }
        let sourcePath = URL(fileURLWithPath: session.path).standardizedFileURL.path
        let targetPath = URL(fileURLWithPath: path).standardizedFileURL.path
        if !sourcePath.isEmpty && sourcePath == targetPath {
            _ = try runAppleScript("tell application id \"com.microsoft.Excel\" to save workbook \(quoted(session.name))")
            return ["sessionId": session.id, "path": targetPath, "saved": true]
        }
        let overwrite = params["overwrite"] as? Bool ?? false
        if FileManager.default.fileExists(atPath: targetPath) && !overwrite {
            throw OfficeFailure(code: "office_target_exists")
        }
        let displacedPath = FileManager.default.fileExists(atPath: targetPath)
            ? "\(targetPath).ling-overwrite-\(UUID().uuidString)"
            : nil
        if let displacedPath {
            do {
                try FileManager.default.moveItem(atPath: targetPath, toPath: displacedPath)
            } catch {
                throw OfficeFailure(code: "office_driver_overwrite_recovery_failed")
            }
        }
        do {
            let source = "tell application id \"com.microsoft.Excel\" to save workbook \(quoted(session.name)) as filename \(quoted(targetPath))"
            _ = try runAppleScript(source)
            if let displacedPath { try? FileManager.default.removeItem(atPath: displacedPath) }
            return ["sessionId": session.id, "path": targetPath, "saved": true]
        } catch {
            let restored = restoreDisplacedTarget(targetPath: targetPath, displacedPath: displacedPath)
            if !restored { throw OfficeFailure(code: "office_driver_overwrite_recovery_failed") }
            throw error
        }
    }

    private func ensureRecovery(_ session: WorkbookSession, idempotencyKey: String) throws {
        if session.readOnly { throw OfficeFailure(code: "office_driver_workbook_read_only") }
        guard !session.path.isEmpty, session.path.hasPrefix("/"), FileManager.default.fileExists(atPath: session.path) else {
            throw OfficeFailure(code: "office_driver_recovery_unavailable")
        }
        let runId = idempotencyKey.split(separator: ":", maxSplits: 1).first.map(String.init) ?? "run"
        let recoveryKey = "\(runId):\(session.id)"
        if recovered.contains(recoveryKey) { return }
        guard let root = ProcessInfo.processInfo.environment["LING_OFFICE_RECOVERY_ROOT"], root.hasPrefix("/") else {
            throw OfficeFailure(code: "office_driver_recovery_unavailable")
        }
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        let destination = URL(fileURLWithPath: root).appendingPathComponent("\(fnv1a64(session.path))-\(UUID().uuidString).xlsx").path
        try FileManager.default.copyItem(atPath: session.path, toPath: destination)
        recovered.insert(recoveryKey)
    }

    private func ensureExcelPermission(prompt: Bool) throws {
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: excelBundleIdentifier) != nil else {
            throw OfficeFailure(code: "office_driver_office_missing")
        }
        guard NSRunningApplication.runningApplications(withBundleIdentifier: excelBundleIdentifier).isEmpty == false else {
            throw OfficeFailure(code: "office_driver_application_not_running")
        }
        guard excelPermission(prompt: prompt) else { throw OfficeFailure(code: "office_driver_permission_required") }
    }

    private func excelPermission(prompt: Bool) -> Bool {
        var descriptor = AEAddressDesc()
        let bytes = Array(excelBundleIdentifier.utf8)
        let createStatus = bytes.withUnsafeBytes { pointer in
            AECreateDesc(DescType(typeApplicationBundleID), pointer.baseAddress, bytes.count, &descriptor)
        }
        guard createStatus == noErr else { return false }
        defer { AEDisposeDesc(&descriptor) }
        return AEDeterminePermissionToAutomateTarget(&descriptor, AEEventClass(typeWildCard), AEEventID(typeWildCard), prompt) == noErr
    }

    private func runAppleScript(_ source: String) throws -> Any {
        guard let script = NSAppleScript(source: source) else { throw OfficeFailure(code: "office_driver_script_invalid") }
        var error: NSDictionary?
        let descriptor = script.executeAndReturnError(&error)
        if error != nil { throw OfficeFailure(code: "office_driver_excel_command_failed") }
        return descriptorValue(descriptor)
    }

    private func sessionProjection(_ session: WorkbookSession) -> [String: Any] {
        return [
            "id": session.id,
            "generation": 1,
            "platform": "darwin",
            "application": "excel",
            "workbookName": session.name,
            "workbookPath": session.path,
            "activeSheet": session.activeSheet,
            "readOnly": session.readOnly,
            "dirty": session.dirty,
            "capabilities": [
                "excel:sessions", "excel:read", "excel:search", "excel:write",
                "excel:sheets", "excel:format-basic", "excel:save", "excel:save-as",
            ],
        ]
    }

    private func cache(_ response: [String: Any], for key: String) {
        completed[key] = response
        completedOrder.append(key)
        while completedOrder.count > 256 {
            completed.removeValue(forKey: completedOrder.removeFirst())
        }
    }
}

func descriptorValue(_ descriptor: NSAppleEventDescriptor) -> Any {
    if descriptor.numberOfItems > 0 {
        return (1...descriptor.numberOfItems).compactMap { index in
            descriptor.atIndex(index).map(descriptorValue)
        }
    }
    if descriptor.descriptorType == typeBoolean { return descriptor.booleanValue }
    if let value = descriptor.stringValue { return value }
    return descriptor.int32Value
}

func normalizeRows(_ value: Any) -> [[Any]] {
    if let rows = value as? [[Any]] { return rows }
    if let row = value as? [Any] { return [row] }
    return [[value]]
}

func fileRevision(_ path: String) -> String {
    guard !path.isEmpty,
          let attributes = try? FileManager.default.attributesOfItem(atPath: path),
          let size = attributes[.size] as? NSNumber,
          let modifiedAt = attributes[.modificationDate] as? Date else { return "" }
    return "\(size.uint64Value):\(Int64(modifiedAt.timeIntervalSince1970 * 1_000))"
}

func restoreDisplacedTarget(targetPath: String, displacedPath: String?) -> Bool {
    guard let displacedPath else { return true }
    do {
        if FileManager.default.fileExists(atPath: targetPath) {
            try FileManager.default.removeItem(atPath: targetPath)
        }
        try FileManager.default.moveItem(atPath: displacedPath, toPath: targetPath)
        return true
    } catch {
        return false
    }
}

func splitRange(_ value: String, defaultSheet: String) -> (sheet: String, address: String) {
    guard let marker = value.lastIndex(of: "!") else { return (defaultSheet, value) }
    return (String(value[..<marker]), String(value[value.index(after: marker)...]))
}

func quoted(_ value: String) -> String {
    return "\"\(value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\r", with: "\\r").replacingOccurrences(of: "\n", with: "\\n"))\""
}

func appleScriptLiteral(_ value: Any) throws -> String {
    if value is NSNull { return "missing value" }
    if let text = value as? String { return quoted(text) }
    if let boolean = value as? Bool { return boolean ? "true" : "false" }
    if let number = value as? NSNumber { return number.stringValue }
    if let array = value as? [Any] { return "{\(try array.map(appleScriptLiteral).joined(separator: ","))}" }
    throw OfficeFailure(code: "office_driver_value_unsupported")
}

func boundedString(_ value: Any?, max: Int) -> String? {
    guard let string = value as? String, !string.isEmpty, string.count <= max else { return nil }
    return string
}

func deadlineExpired(_ value: String) -> Bool {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    guard let date else { return true }
    return date <= Date()
}

func fnv1a64(_ value: String) -> String {
    var hash: UInt64 = 14695981039346656037
    for byte in value.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
    return String(hash, radix: 16)
}

func success(id: String, result: Any) -> [String: Any] {
    return ["protocol": protocolVersion, "id": id, "ok": true, "result": result]
}

func failure(id: String, code: String) -> [String: Any] {
    return [
        "protocol": protocolVersion,
        "id": String(id.prefix(128)),
        "ok": false,
        "error": ["code": code, "message": "The local Excel driver could not complete the request."],
    ]
}

func readExactly(_ count: Int) throws -> Data? {
    var output = Data()
    while output.count < count {
        guard let chunk = try FileHandle.standardInput.read(upToCount: count - output.count), !chunk.isEmpty else {
            if output.isEmpty { return nil }
            throw OfficeFailure(code: "office_driver_frame_truncated")
        }
        output.append(chunk)
    }
    return output
}

func startParentWatchdog() throws {
    guard let rawParentPid = ProcessInfo.processInfo.environment["LING_OFFICE_PARENT_PID"],
          let parentPid = Int32(rawParentPid),
          parentPid > 1 else {
        throw OfficeFailure(code: "office_driver_parent_invalid")
    }
    DispatchQueue.global(qos: .utility).async {
        while true {
            if kill(parentPid, 0) != 0 && errno == ESRCH { _exit(0) }
            Thread.sleep(forTimeInterval: 0.25)
        }
    }
}

func writeFrame(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value)
    guard !data.isEmpty, data.count <= maximumResultBytes else { throw OfficeFailure(code: "office_driver_result_too_large") }
    var length = UInt32(data.count).littleEndian
    let header = Data(bytes: &length, count: 4)
    try FileHandle.standardOutput.write(contentsOf: header)
    try FileHandle.standardOutput.write(contentsOf: data)
}

@main
enum LingOfficeDriverMain {
    static func main() throws {
        try startParentWatchdog()
        let driver = OfficeDriver()
        while let header = try readExactly(4) {
            let size = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
            guard size > 0, size <= maximumFrameBytes else { break }
            guard let payload = try readExactly(Int(size)),
                  let request = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else { break }
            try writeFrame(driver.handle(request))
        }
    }
}
