import { parentPort, workerData } from "node:worker_threads";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

// Website schemas are untrusted. Compilation and validation run in a disposable worker.
try {
  const { schema, args } = workerData as { schema: Record<string, unknown>; args: object };
  const validator = schema.$schema === "https://json-schema.org/draft/2020-12/schema"
    ? new Ajv2020({ strict: false, ownProperties: true, validateFormats: false })
    : new Ajv({ strict: false, ownProperties: true, validateFormats: false });
  const validate = validator.compile(schema);
  parentPort?.postMessage({ valid: validate(args) === true });
} catch {
  parentPort?.postMessage({ invalidSchema: true });
}
