import { parentPort, workerData } from "node:worker_threads";
import { queryCodeSnapshot } from "./query.js";

try { parentPort!.postMessage({ ok: true, result: queryCodeSnapshot(workerData.snapshot, workerData.query) }); }
catch (error) { parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
