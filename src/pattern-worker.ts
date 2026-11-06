/**
 * Worker entry for schemas that use `pattern` (see validateArgumentsGuarded in
 * schema.ts). The host terminates this worker at a deadline, so a catastrophic
 * regex stalls only this thread. It has no I/O: it takes one {schema, args}
 * message and posts back {valid, errors} or {crashed: true}.
 */

import type { ErrorObject } from "ajv";
import type { JsonSchema } from "@utcp/sdk";
import { makeAjv } from "./schema.js";

interface PatternRequest {
  schema: unknown;
  args: unknown;
}

function toPlainError(error: ErrorObject): { keyword: string; instancePath: string; params: Record<string, unknown>; message?: string } {
  return {
    keyword: error.keyword,
    instancePath: error.instancePath,
    params: { ...error.params },
    ...(error.message === undefined ? {} : { message: error.message }),
  };
}

// The lib set has no DOM or worker typings, so the worker global is typed here.
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<PatternRequest>) => void) | null };
scope.onmessage = (event: MessageEvent<PatternRequest>) => {
  let reply: unknown;
  try {
    const validate = makeAjv().compile(event.data.schema as JsonSchema);
    const valid = validate(event.data.args) === true;
    reply = { valid, errors: valid ? [] : (validate.errors ?? []).map(toPlainError) };
  } catch {
    reply = { crashed: true };
  }
  postMessage(reply);
};
