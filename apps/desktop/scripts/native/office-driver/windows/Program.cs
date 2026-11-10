using System.Globalization;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Ling.Office.Driver;

internal sealed class OfficeFailure(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

internal sealed record WorkbookSession(
    string Id,
    string Name,
    string Path,
    string ActiveSheet,
    bool ReadOnly,
    bool Dirty,
    string FileRevision
);

internal static class Program
{
    private const string Protocol = "ling.office.driver.v1";
    private const string HelperVersion = "0.1.0";
    private const int MaximumFrameBytes = 4 * 1024 * 1024;
    private const int MaximumResultBytes = 8 * 1024 * 1024;
    private static readonly Dictionary<string, JsonObject> Completed = new(StringComparer.Ordinal);
    private static readonly Queue<string> CompletedOrder = new();
    private static readonly Dictionary<string, WorkbookSession> Sessions = new(StringComparer.Ordinal);
    private static readonly HashSet<string> Recovered = new(StringComparer.Ordinal);
    private static readonly HashSet<string> ExternallyChanged = new(StringComparer.Ordinal);
    private static Process? ParentProcess;

    [STAThread]
    private static async Task<int> Main()
    {
        if (!StartParentWatchdog()) return 2;
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        try
        {
            while (true)
            {
                byte[]? header = await ReadExactly(input, 4);
                if (header is null) return 0;
                uint size = BitConverter.ToUInt32(header, 0);
                if (size is 0 or > MaximumFrameBytes) return 2;
                byte[]? payload = await ReadExactly(input, checked((int)size));
                if (payload is null) return 2;
                JsonObject request = JsonNode.Parse(payload)?.AsObject()
                    ?? throw new OfficeFailure("office_driver_frame_json_invalid");
                await WriteFrame(output, Handle(request));
            }
        }
        catch
        {
            return 2;
        }
    }

    private static JsonObject Handle(JsonObject request)
    {
        string id = ReadString(request, "id", 128, "invalid");
        try
        {
            string[] allowedKeys = ["protocol", "id", "method", "params", "deadlineAt", "idempotencyKey"];
            if (request.Count != allowedKeys.Length || allowedKeys.Any(key => !request.ContainsKey(key)))
                throw new OfficeFailure("office_driver_request_invalid");
            if (ReadString(request, "protocol", 64) != Protocol) throw new OfficeFailure("office_driver_request_invalid");
            string method = ReadString(request, "method", 64);
            string idempotencyKey = ReadString(request, "idempotencyKey", 256);
            string deadline = ReadString(request, "deadlineAt", 64);
            if (!DateTimeOffset.TryParse(deadline, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out DateTimeOffset parsedDeadline)
                || parsedDeadline <= DateTimeOffset.UtcNow) throw new OfficeFailure("office_driver_request_invalid");
            if (Completed.TryGetValue(idempotencyKey, out JsonObject? cached))
            {
                JsonObject replay = (JsonObject)cached.DeepClone();
                replay["id"] = id;
                return replay;
            }

            JsonObject parameters = request["params"] as JsonObject ?? throw new OfficeFailure("office_driver_request_invalid");
            JsonNode? result = Execute(method, parameters, idempotencyKey);
            JsonObject response = Success(id, result);
            Completed[idempotencyKey] = (JsonObject)response.DeepClone();
            CompletedOrder.Enqueue(idempotencyKey);
            while (CompletedOrder.Count > 256) Completed.Remove(CompletedOrder.Dequeue());
            return response;
        }
        catch (OfficeFailure failure)
        {
            return Failure(id, failure.Code);
        }
        catch
        {
            return Failure(id, "office_driver_failed");
        }
    }

    private static JsonNode? Execute(string method, JsonObject parameters, string idempotencyKey)
    {
        if (method == "driver_status") return DriverStatus();
        object excel = GetRunningExcel();
        try
        {
            return method switch
            {
                "list_sessions" => ListSessions(excel),
                "read_ranges" => ReadRanges(excel, parameters),
                "search_workbook" => SearchWorkbook(excel, parameters),
                "write_range" => Mutate(excel, parameters, idempotencyKey, WriteRange),
                "update_sheet" => Mutate(excel, parameters, idempotencyKey, UpdateSheet),
                "format_range" => Mutate(excel, parameters, idempotencyKey, FormatRange),
                "save_workbook" => Mutate(excel, parameters, idempotencyKey, SaveWorkbook),
                "save_workbook_as" => Mutate(excel, parameters, idempotencyKey, SaveWorkbookAs),
                "create_table" => Mutate(excel, parameters, idempotencyKey, CreateTable),
                "create_chart" => Mutate(excel, parameters, idempotencyKey, CreateChart),
                "apply_filter" => Mutate(excel, parameters, idempotencyKey, ApplyFilter),
                "resize_range" => Mutate(excel, parameters, idempotencyKey, ResizeRange),
                _ => throw new OfficeFailure("office_driver_capability_unavailable"),
            };
        }
        finally
        {
            Release(excel);
        }
    }

    private static JsonObject DriverStatus()
    {
        bool installed = Type.GetTypeFromProgID("Excel.Application", throwOnError: false) is not null;
        bool running = false;
        if (installed)
        {
            try { dynamic excel = GetRunningExcel(); running = true; Release(excel); }
            catch (OfficeFailure) { }
        }
        return new JsonObject
        {
            ["helperVersion"] = HelperVersion,
            ["state"] = !installed ? "office_missing" : !running ? "application_not_running" : "ready",
            ["capabilities"] = installed ? Capabilities() : new JsonArray(),
            ["officeInstalled"] = installed,
            ["applicationRunning"] = running,
            ["permissionGranted"] = true,
        };
    }

    private static JsonArray Capabilities() => new(
        "excel:sessions", "excel:read", "excel:search", "excel:write",
        "excel:sheets", "excel:format-basic", "excel:save", "excel:save-as",
        "excel:tables", "excel:charts", "excel:filters", "excel:resize"
    );

    private static JsonArray ListSessions(dynamic excel, bool clearExternalChangeFences = true)
    {
        Sessions.Clear();
        JsonArray output = [];
        int count = Convert.ToInt32(excel.Workbooks.Count, CultureInfo.InvariantCulture);
        for (int index = 1; index <= count; index++)
        {
            dynamic workbook = excel.Workbooks[index];
            try
            {
                string name = Convert.ToString(workbook.Name, CultureInfo.InvariantCulture) ?? "Workbook";
                string path = Convert.ToString(workbook.FullName, CultureInfo.InvariantCulture) ?? "";
                string activeSheet = Convert.ToString(workbook.ActiveSheet?.Name, CultureInfo.InvariantCulture) ?? "";
                string stable = string.IsNullOrWhiteSpace(path) ? name : path;
                WorkbookSession session = new(
                    $"excel-{Fnv1A64(stable):x16}", name, path, activeSheet,
                    Convert.ToBoolean(workbook.ReadOnly, CultureInfo.InvariantCulture),
                    !Convert.ToBoolean(workbook.Saved, CultureInfo.InvariantCulture),
                    FileRevision(path)
                );
                Sessions[session.Id] = session;
                output.Add(SessionProjection(session));
            }
            finally { Release(workbook); }
        }
        if (clearExternalChangeFences) ExternallyChanged.Clear();
        return output;
    }

    private static WorkbookSession RequireSession(dynamic excel, JsonObject parameters, out dynamic workbook)
    {
        string sessionId = ReadString(parameters, "sessionId", 256);
        if (ExternallyChanged.Contains(sessionId)) throw new OfficeFailure("office_driver_workbook_changed_externally");
        Sessions.TryGetValue(sessionId, out WorkbookSession? previous);
        _ = ListSessions(excel, clearExternalChangeFences: false);
        if (!Sessions.TryGetValue(sessionId, out WorkbookSession? session)) throw new OfficeFailure("office_driver_session_stale");
        if (previous is not null
            && !string.IsNullOrEmpty(previous.FileRevision)
            && !string.IsNullOrEmpty(session.FileRevision)
            && !string.Equals(previous.FileRevision, session.FileRevision, StringComparison.Ordinal))
        {
            ExternallyChanged.Add(sessionId);
            throw new OfficeFailure("office_driver_workbook_changed_externally");
        }
        workbook = excel.Workbooks[session.Name];
        return session;
    }

    private static JsonNode ReadRanges(dynamic excel, JsonObject parameters)
    {
        WorkbookSession session = RequireSession(excel, parameters, out dynamic workbook);
        try
        {
            JsonArray ranges = parameters["ranges"] as JsonArray ?? throw new OfficeFailure("office_driver_range_invalid");
            if (ranges.Count is < 1 or > 50) throw new OfficeFailure("office_driver_range_invalid");
            JsonArray output = [];
            foreach (JsonNode? node in ranges)
            {
                string rawRange = node?.GetValue<string>() ?? throw new OfficeFailure("office_driver_range_invalid");
                (string sheetName, string address) = SplitRange(rawRange, session.ActiveSheet);
                dynamic sheet = workbook.Worksheets[sheetName];
                dynamic range = sheet.Range[address];
                try
                {
                    output.Add(new JsonObject
                    {
                        ["range"] = rawRange,
                        ["values"] = ToJson(range.Value2),
                        ["formulas"] = ToJson(range.Formula),
                    });
                }
                finally { Release(range); Release(sheet); }
            }
            return new JsonObject { ["sessionId"] = session.Id, ["ranges"] = output };
        }
        finally { Release(workbook); }
    }

    private static JsonNode SearchWorkbook(dynamic excel, JsonObject parameters)
    {
        WorkbookSession session = RequireSession(excel, parameters, out dynamic workbook);
        string query = ReadString(parameters, "query", 512);
        int maxResults = Math.Clamp(parameters["maxResults"]?.GetValue<int>() ?? 50, 1, 200);
        JsonArray matches = [];
        try
        {
            int sheetCount = Convert.ToInt32(workbook.Worksheets.Count, CultureInfo.InvariantCulture);
            for (int sheetIndex = 1; sheetIndex <= sheetCount; sheetIndex++)
            {
                dynamic sheet = workbook.Worksheets[sheetIndex];
                dynamic used = sheet.UsedRange;
                try
                {
                    int rows = Convert.ToInt32(used.Rows.Count, CultureInfo.InvariantCulture);
                    int columns = Convert.ToInt32(used.Columns.Count, CultureInfo.InvariantCulture);
                    if ((long)rows * columns > 250_000) throw new OfficeFailure("office_driver_search_too_large");
                    object? values = used.Value2;
                    for (int row = 1; row <= rows; row++)
                    for (int column = 1; column <= columns; column++)
                    {
                        object? value = MatrixValue(values, row, column);
                        if ((Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Contains(query, StringComparison.CurrentCultureIgnoreCase))
                        {
                            matches.Add(new JsonObject { ["sheet"] = Convert.ToString(sheet.Name), ["row"] = row, ["column"] = column, ["value"] = ToJson(value) });
                            if (matches.Count >= maxResults) return new JsonObject { ["sessionId"] = session.Id, ["matches"] = matches, ["truncated"] = true };
                        }
                    }
                }
                finally { Release(used); Release(sheet); }
            }
            return new JsonObject { ["sessionId"] = session.Id, ["matches"] = matches, ["truncated"] = false };
        }
        finally { Release(workbook); }
    }

    private delegate JsonNode Mutation(dynamic workbook, WorkbookSession session, JsonObject parameters);

    private static JsonNode Mutate(dynamic excel, JsonObject parameters, string idempotencyKey, Mutation mutation)
    {
        WorkbookSession session = RequireSession(excel, parameters, out dynamic workbook);
        try
        {
            EnsureRecovery(session, idempotencyKey);
            JsonNode result = mutation(workbook, session, parameters);
            try { _ = ListSessions(excel, clearExternalChangeFences: false); } catch { }
            return result;
        }
        finally { Release(workbook); }
    }

    private static JsonNode WriteRange(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string rawRange = ReadString(parameters, "range", 64);
        (string sheetName, string address) = SplitRange(rawRange, session.ActiveSheet);
        dynamic sheet = workbook.Worksheets[sheetName];
        dynamic range = sheet.Range[address];
        try
        {
            if (parameters["formulas"] is JsonArray formulas) range.Formula = ToMatrix(formulas);
            else if (parameters["values"] is JsonArray values) range.Value2 = ToMatrix(values);
            else throw new OfficeFailure("office_driver_values_required");
            return new JsonObject { ["sessionId"] = session.Id, ["range"] = rawRange, ["written"] = true };
        }
        finally { Release(range); Release(sheet); }
    }

    private static JsonNode UpdateSheet(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string action = ReadString(parameters, "action", 16);
        if (action == "create")
        {
            dynamic sheet = workbook.Worksheets.Add(After: workbook.Worksheets[workbook.Worksheets.Count]);
            try { sheet.Name = ReadString(parameters, "name", 31); }
            finally { Release(sheet); }
        }
        else if (action == "rename")
        {
            dynamic sheet = workbook.Worksheets[ReadString(parameters, "sheet", 31)];
            try { sheet.Name = ReadString(parameters, "name", 31); }
            finally { Release(sheet); }
        }
        else if (action == "delete")
        {
            dynamic sheet = workbook.Worksheets[ReadString(parameters, "sheet", 31)];
            try { sheet.Delete(); }
            finally { Release(sheet); }
        }
        else throw new OfficeFailure("office_driver_sheet_action_invalid");
        return new JsonObject { ["sessionId"] = session.Id, ["updated"] = true };
    }

    private static JsonNode FormatRange(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string rawRange = ReadString(parameters, "range", 64);
        JsonObject format = parameters["format"] as JsonObject ?? throw new OfficeFailure("office_driver_format_invalid");
        (string sheetName, string address) = SplitRange(rawRange, session.ActiveSheet);
        dynamic sheet = workbook.Worksheets[sheetName];
        dynamic range = sheet.Range[address];
        try
        {
            if (format["bold"] is JsonValue bold) range.Font.Bold = bold.GetValue<bool>();
            if (format["italic"] is JsonValue italic) range.Font.Italic = italic.GetValue<bool>();
            if (format["numberFormat"] is JsonValue numberFormat) range.NumberFormat = numberFormat.GetValue<string>();
            if (format["fillColor"] is JsonValue fill) range.Interior.Color = OleColor(fill.GetValue<string>());
            if (format["fontColor"] is JsonValue font) range.Font.Color = OleColor(font.GetValue<string>());
            return new JsonObject { ["sessionId"] = session.Id, ["range"] = rawRange, ["formatted"] = true };
        }
        finally { Release(range); Release(sheet); }
    }

    private static JsonNode SaveWorkbook(dynamic workbook, WorkbookSession session, JsonObject _)
    {
        workbook.Save();
        return new JsonObject { ["sessionId"] = session.Id, ["saved"] = true };
    }

    private static JsonNode SaveWorkbookAs(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string path = Path.GetFullPath(ReadString(parameters, "path", 4096));
        if (!Path.IsPathFullyQualified(path) || !path.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase)) throw new OfficeFailure("office_driver_save_path_invalid");
        if (!string.IsNullOrWhiteSpace(session.Path)
            && string.Equals(Path.GetFullPath(session.Path), path, StringComparison.OrdinalIgnoreCase))
        {
            workbook.Save();
            return new JsonObject { ["sessionId"] = session.Id, ["path"] = path, ["saved"] = true };
        }
        bool overwrite = parameters["overwrite"]?.GetValue<bool>() ?? false;
        if (File.Exists(path) && !overwrite) throw new OfficeFailure("office_target_exists");
        string? displacedPath = File.Exists(path) ? $"{path}.ling-overwrite-{Guid.NewGuid():N}" : null;
        if (displacedPath is not null)
        {
            try { File.Move(path, displacedPath); }
            catch { throw new OfficeFailure("office_driver_overwrite_recovery_failed"); }
        }
        try
        {
            workbook.SaveAs(path, 51);
            if (displacedPath is not null)
            {
                try { File.Delete(displacedPath); } catch { }
            }
            return new JsonObject { ["sessionId"] = session.Id, ["path"] = path, ["saved"] = true };
        }
        catch
        {
            if (!RestoreDisplacedTarget(path, displacedPath))
                throw new OfficeFailure("office_driver_overwrite_recovery_failed");
            throw;
        }
    }

    private static JsonNode CreateTable(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string rawRange = ReadString(parameters, "range", 64);
        (string sheetName, string address) = SplitRange(rawRange, session.ActiveSheet);
        dynamic sheet = workbook.Worksheets[sheetName];
        dynamic range = sheet.Range[address];
        dynamic table = sheet.ListObjects.Add(1, range, Type.Missing, parameters["hasHeaders"]?.GetValue<bool>() == false ? 2 : 1);
        try { table.Name = ReadString(parameters, "name", 128); }
        finally { Release(table); Release(range); Release(sheet); }
        return new JsonObject { ["sessionId"] = session.Id, ["created"] = true };
    }

    private static JsonNode CreateChart(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string rawRange = ReadString(parameters, "range", 64);
        (string sheetName, string address) = SplitRange(rawRange, session.ActiveSheet);
        dynamic sheet = workbook.Worksheets[sheetName];
        dynamic range = sheet.Range[address];
        dynamic chartObject = sheet.ChartObjects().Add(40, 40, 480, 280);
        dynamic chart = chartObject.Chart;
        try
        {
            chart.SetSourceData(range);
            chart.ChartType = ChartType(ReadString(parameters, "chartType", 16));
            if (parameters["title"] is JsonValue title)
            {
                chart.HasTitle = true;
                chart.ChartTitle.Text = title.GetValue<string>();
            }
        }
        finally { Release(chart); Release(chartObject); Release(range); Release(sheet); }
        return new JsonObject { ["sessionId"] = session.Id, ["created"] = true };
    }

    private static JsonNode ApplyFilter(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string rawRange = ReadString(parameters, "range", 64);
        (string sheetName, string address) = SplitRange(rawRange, session.ActiveSheet);
        dynamic sheet = workbook.Worksheets[sheetName];
        dynamic range = sheet.Range[address];
        try { range.AutoFilter(parameters["field"]!.GetValue<int>(), ReadString(parameters, "criteria", 512)); }
        finally { Release(range); Release(sheet); }
        return new JsonObject { ["sessionId"] = session.Id, ["filtered"] = true };
    }

    private static JsonNode ResizeRange(dynamic workbook, WorkbookSession session, JsonObject parameters)
    {
        string rawRange = ReadString(parameters, "range", 64);
        (string sheetName, string address) = SplitRange(rawRange, session.ActiveSheet);
        dynamic sheet = workbook.Worksheets[sheetName];
        dynamic range = sheet.Range[address];
        try
        {
            if (parameters["columnWidth"] is JsonValue width) range.EntireColumn.ColumnWidth = width.GetValue<double>();
            if (parameters["rowHeight"] is JsonValue height) range.EntireRow.RowHeight = height.GetValue<double>();
        }
        finally { Release(range); Release(sheet); }
        return new JsonObject { ["sessionId"] = session.Id, ["resized"] = true };
    }

    private static void EnsureRecovery(WorkbookSession session, string idempotencyKey)
    {
        if (session.ReadOnly) throw new OfficeFailure("office_driver_workbook_read_only");
        if (string.IsNullOrWhiteSpace(session.Path) || !Path.IsPathFullyQualified(session.Path) || !File.Exists(session.Path)) throw new OfficeFailure("office_driver_recovery_unavailable");
        string runId = idempotencyKey.Split(':', 2)[0];
        string key = $"{runId}:{session.Id}";
        if (Recovered.Contains(key)) return;
        string root = Environment.GetEnvironmentVariable("LING_OFFICE_RECOVERY_ROOT") ?? throw new OfficeFailure("office_driver_recovery_unavailable");
        if (!Path.IsPathFullyQualified(root)) throw new OfficeFailure("office_driver_recovery_unavailable");
        Directory.CreateDirectory(root);
        string destination = Path.Combine(root, $"{Fnv1A64(session.Path):x16}-{Guid.NewGuid():N}.xlsx");
        File.Copy(session.Path, destination, overwrite: false);
        Recovered.Add(key);
    }

    private static JsonObject SessionProjection(WorkbookSession session) => new()
    {
        ["id"] = session.Id,
        ["generation"] = 1,
        ["platform"] = "win32",
        ["application"] = "excel",
        ["workbookName"] = session.Name,
        ["workbookPath"] = session.Path,
        ["activeSheet"] = session.ActiveSheet,
        ["readOnly"] = session.ReadOnly,
        ["dirty"] = session.Dirty,
        ["capabilities"] = Capabilities(),
    };

    private static dynamic GetRunningExcel()
    {
        Type? type = Type.GetTypeFromProgID("Excel.Application", throwOnError: false);
        if (type is null) throw new OfficeFailure("office_driver_office_missing");
        Guid clsid = type.GUID;
        int status = GetActiveObject(ref clsid, IntPtr.Zero, out object? instance);
        if (status != 0 || instance is null) throw new OfficeFailure("office_driver_application_not_running");
        return instance;
    }

    private static object[,] ToMatrix(JsonArray rows)
    {
        if (rows.Count is < 1 or > 10_000) throw new OfficeFailure("office_driver_matrix_invalid");
        int columns = (rows[0] as JsonArray)?.Count ?? throw new OfficeFailure("office_driver_matrix_invalid");
        if (columns is < 1 or > 256) throw new OfficeFailure("office_driver_matrix_invalid");
        object[,] output = new object[rows.Count, columns];
        for (int row = 0; row < rows.Count; row++)
        {
            JsonArray values = rows[row] as JsonArray ?? throw new OfficeFailure("office_driver_matrix_invalid");
            if (values.Count != columns) throw new OfficeFailure("office_driver_matrix_invalid");
            for (int column = 0; column < columns; column++) output[row, column] = FromJson(values[column]);
        }
        return output;
    }

    private static object? FromJson(JsonNode? value)
    {
        if (value is null) return null;
        if (value is JsonValue json)
        {
            if (json.TryGetValue<bool>(out bool boolean)) return boolean;
            if (json.TryGetValue<double>(out double number)) return number;
            if (json.TryGetValue<string>(out string? text)) return text;
        }
        throw new OfficeFailure("office_driver_value_unsupported");
    }

    private static JsonNode? ToJson(object? value)
    {
        if (value is null) return null;
        if (value is Array array && array.Rank == 2)
        {
            JsonArray rows = [];
            for (int row = array.GetLowerBound(0); row <= array.GetUpperBound(0); row++)
            {
                JsonArray columns = [];
                for (int column = array.GetLowerBound(1); column <= array.GetUpperBound(1); column++) columns.Add(ToJson(array.GetValue(row, column)));
                rows.Add(columns);
            }
            return rows;
        }
        return value switch
        {
            bool boolean => JsonValue.Create(boolean),
            byte or short or int or long or float or double or decimal => JsonValue.Create(Convert.ToDouble(value, CultureInfo.InvariantCulture)),
            DateTime date => JsonValue.Create(date.ToString("O", CultureInfo.InvariantCulture)),
            _ => JsonValue.Create(Convert.ToString(value, CultureInfo.InvariantCulture)),
        };
    }

    private static object? MatrixValue(object? value, int row, int column)
    {
        if (value is Array array && array.Rank == 2) return array.GetValue(row, column);
        return row == 1 && column == 1 ? value : null;
    }

    private static (string Sheet, string Address) SplitRange(string value, string defaultSheet)
    {
        int marker = value.LastIndexOf('!');
        return marker < 0 ? (defaultSheet, value) : (value[..marker], value[(marker + 1)..]);
    }

    private static int OleColor(string value)
    {
        string hex = value.TrimStart('#');
        if (hex.Length != 6 || !int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int rgb)) throw new OfficeFailure("office_driver_color_invalid");
        int red = (rgb >> 16) & 255, green = (rgb >> 8) & 255, blue = rgb & 255;
        return red | (green << 8) | (blue << 16);
    }

    private static int ChartType(string value) => value switch
    {
        "column" => 51,
        "bar" => 57,
        "line" => 4,
        "pie" => 5,
        "scatter" => -4169,
        _ => throw new OfficeFailure("office_driver_chart_type_invalid"),
    };

    private static string ReadString(JsonObject value, string key, int max, string? fallback = null)
    {
        string? text = value[key]?.GetValue<string>();
        if (!string.IsNullOrEmpty(text) && text.Length <= max) return text;
        if (fallback is not null) return fallback;
        throw new OfficeFailure("office_driver_request_invalid");
    }

    private static JsonObject Success(string id, JsonNode? result) => new()
    {
        ["protocol"] = Protocol,
        ["id"] = id,
        ["ok"] = true,
        ["result"] = result,
    };

    private static JsonObject Failure(string id, string code) => new()
    {
        ["protocol"] = Protocol,
        ["id"] = id.Length <= 128 ? id : id[..128],
        ["ok"] = false,
        ["error"] = new JsonObject
        {
            ["code"] = code,
            ["message"] = "The local Excel driver could not complete the request.",
        },
    };

    private static async Task<byte[]?> ReadExactly(Stream stream, int count)
    {
        byte[] bytes = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = await stream.ReadAsync(bytes.AsMemory(offset, count - offset));
            if (read == 0)
            {
                if (offset == 0) return null;
                throw new OfficeFailure("office_driver_frame_truncated");
            }
            offset += read;
        }
        return bytes;
    }

    private static async Task WriteFrame(Stream stream, JsonObject value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value);
        if (payload.Length is 0 or > MaximumResultBytes) throw new OfficeFailure("office_driver_result_too_large");
        byte[] header = BitConverter.GetBytes((uint)payload.Length);
        await stream.WriteAsync(header);
        await stream.WriteAsync(payload);
        await stream.FlushAsync();
    }

    private static bool StartParentWatchdog()
    {
        string? rawParentPid = Environment.GetEnvironmentVariable("LING_OFFICE_PARENT_PID");
        if (!int.TryParse(rawParentPid, NumberStyles.None, CultureInfo.InvariantCulture, out int parentPid) || parentPid <= 1)
            return false;
        try
        {
            Process parentProcess = Process.GetProcessById(parentPid);
            ParentProcess = parentProcess;
            _ = Task.Run(async () =>
            {
                try { await parentProcess.WaitForExitAsync(); }
                finally { Environment.Exit(0); }
            });
            return true;
        }
        catch
        {
            ParentProcess = null;
            return false;
        }
    }

    private static string FileRevision(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return "";
        try
        {
            FileInfo file = new(path);
            return $"{file.Length}:{file.LastWriteTimeUtc.Ticks}";
        }
        catch { return ""; }
    }

    private static bool RestoreDisplacedTarget(string targetPath, string? displacedPath)
    {
        if (displacedPath is null) return true;
        try
        {
            if (File.Exists(targetPath)) File.Delete(targetPath);
            File.Move(displacedPath, targetPath);
            return true;
        }
        catch { return false; }
    }

    private static ulong Fnv1A64(string value)
    {
        ulong hash = 14695981039346656037UL;
        foreach (byte item in System.Text.Encoding.UTF8.GetBytes(value)) hash = (hash ^ item) * 1099511628211UL;
        return hash;
    }

    private static void Release(object? value)
    {
        if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }

    [DllImport("oleaut32.dll", PreserveSig = true)]
    private static extern int GetActiveObject(ref Guid rclsid, IntPtr reserved, [MarshalAs(UnmanagedType.Interface)] out object? instance);
}
