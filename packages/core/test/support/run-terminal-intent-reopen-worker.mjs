import { SqliteRunStore } from "../../dist/storage/sqlite-run-store.js";
import { createDelegationHostStoreBinding } from "../../dist/delegation-host-store-bridge.js";

// Isolated test process only: reconstruct constructor custody, not original
// Runner authority. This worker cannot mint a receipt, launch or settle usage.
const [cwd, encodedPaths, attemptId] = process.argv.slice(2);
const deny = () => { throw new Error("unexpected-execution-authority"); };
const custody = createDelegationHostStoreBinding({ readCapture: deny, readCurrentAuthority: deny, readUsageReceipt: deny, readChildReceipt: deny });
const store = new SqliteRunStore({ cwd, paths: JSON.parse(encodedPaths), delegationHostBinding: custody.binding });
try {
  const result = custody.writer().reconcileRunTerminalIntent({ attemptId, now: new Date().toISOString() });
  process.stdout.write(JSON.stringify({ status: result.status, replayed: result.replayed }));
} finally { store.close(); }
