/**
 * Error vocabulary for the OC2 UTCP adapter.
 *
 * Two rules govern this module:
 *
 * 1. The adapter never re-emits an SDK `Error.message`, an Axios error, a
 *    request URL, headers, or a response body. Spec §7.5 requires the adapter
 *    channel to be free of credentials and payloads, and the UTCP SDK is known
 *    to embed URLs, headers and response fragments in its own error text. Every
 *    message here is therefore a fixed template written by the adapter.
 * 2. Classification is by error shape and message prefix, silently. The text
 *    that was matched is used for a decision only, never copied to output.
 */

/** Fixed error codes; callers may switch on these. */
export const ERROR_CODES = [
  "UNKNOWN_TOOL",
  "TOOL_NOT_ALLOWED",
  "TOOL_UNAVAILABLE",
  "INVALID_ARGUMENTS",
  "VALIDATION_FAILED",
  "SCHEMA_UNSUPPORTED",
  "CONFIG_INVALID",
  "CONFIGURATION_ERROR",
  "TRANSPORT_ERROR",
  "TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A single schema construct the adapter refuses to validate. */
export interface SchemaIssue {
  /** Dotted path into the tool's input schema, e.g. `properties.limit.oneOf`. */
  path: string;
  /** The offending keyword, e.g. `oneOf`. */
  keyword: string;
  /**
   * Validator text for an issue the schema walk cannot name, i.e. a schema the
   * walk accepts but Ajv refuses to compile. Bounded, with each control
   * character replaced by a space rather than deleted; schema-derived, never an
   * argument value.
   */
  message?: string;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  /** Resolved SDK tool name, when the failure concerns a specific tool. */
  tool?: string;
  /**
   * Dotted path into the tool's input schema (schema failures) or into the
   * arguments object (validation failures), e.g. `properties.limit.oneOf` or
   * `arguments.query`.
   */
  path?: string;
  /** Offending JSON Schema keyword. */
  keyword?: string;
  /** Expected JSON type or shape, for validation failures. */
  expected?: string;
  /** Observed JSON type or shape, for validation failures. */
  received?: string;
  /** Present on TOOL_UNAVAILABLE; true only while startup is still running. */
  retryable?: boolean;
  /**
   * Present on TIMEOUT, and when the adapter stopped awaiting a call it could
   * not cancel (caller abort). The remote side may still have executed the
   * call, so the adapter never reports it as cancelled or as not executed.
   * A call aborted BEFORE dispatch carries no outcome: it was never sent, and
   * its message says so.
   */
  outcome?: "unknown";
  /** All schema issues, bounded; first issue is repeated in path/keyword. */
  issues?: readonly SchemaIssue[];
  /** Per-manual startup status, when the failure is reported on first use. */
  manuals?: readonly ManualStatus[];
}

/** Per-manual registration outcome, captured at readiness and frozen. */
export interface ManualStatus {
  name: string;
  transport: string;
  /** Transport class was enabled and the manual was handed to the SDK. */
  registered: boolean;
  /** The SDK reported success. */
  success: boolean;
  /** Adapter-written reason. Never SDK error text. */
  reason?: string;
  /** Number of tools the manual contributed to the executable catalog. */
  tools: number;
}

export interface SuccessResult {
  ok: true;
}

export interface FailureResult {
  ok: false;
  error: ErrorBody;
}

export type ToolResult<T> = { ok: true; result: T } | FailureResult;

/** Error type used inside the adapter for control flow. */
export class UtcpAdapterError extends Error {
  readonly code: ErrorCode;
  readonly detail: Omit<ErrorBody, "code" | "message">;

  constructor(code: ErrorCode, message: string, detail: Omit<ErrorBody, "code" | "message"> = {}) {
    super(message);
    this.name = "UtcpAdapterError";
    this.code = code;
    this.detail = detail;
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message, ...this.detail };
  }
}

export function failure(error: ErrorBody): FailureResult {
  return { ok: false, error };
}

/**
 * Bounds a display-only string and replaces control characters with spaces.
 *
 * Replacement, not deletion: deleting a control character would join the
 * words around it into one token. The output is presentation only and is never
 * used for classification.
 */
export function displayText(value: unknown, maxLength = 200): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const cleared = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return cleared.length > maxLength ? `${cleared.slice(0, Math.max(0, maxLength - 1))}…` : cleared;
}

export function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Structural timeout signals. A remote response body can contain the word
 * "timeout", so the adapter never classifies on a free-text scan: only an
 * error code, an error name, or a message *prefix* that the transport itself
 * writes counts as a timeout.
 */
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNABORTED",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const TIMEOUT_NAME_PATTERN = /^(TimeoutError|Timeout|RequestTimeoutError)$/;
const TIMEOUT_MESSAGE_PREFIX =
  /^(?:timed out|timeout(?: after| exceeded| while)?\b|request timed out|mcp (?:tool call|request|client) timed out)/i;
/**
 * A transport abort raised by its own timeout timer. The streamable-HTTP
 * transport arms `setTimeout(() => controller.abort(), timeout)` and the
 * resulting DOMException reads "The operation was aborted." Undici's
 * `AbortError` and axios's `ERR_CANCELED` share that shape.
 */
const ABORT_AS_TIMEOUT_PATTERN = /^(?:the operation was aborted|aborted)\b/i;
const CONNECTIVITY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/** SDK pre-dispatch messages. Matched by prefix only; never re-emitted. */
const SDK_CONFIGURATION_PREFIXES = [
  "Invalid call template after variable substitution",
  "Could not find manual call template for manual",
  "No communication protocol registered for type:",
  "Required variable",
];

/**
 * SDK pre-dispatch messages whose shape is positional. Matched against the
 * first 64 characters only and never re-emitted.
 */
const SDK_CONFIGURATION_PATTERNS = [
  // "Tool '<name>' uses communication protocol '<t>' which is not allowed by manual '<m>'."
  /^Tool '[^']*' uses communication protocol '/,
];

/**
 * `@utcp/http` refuses a request before it is sent when the resolved URL is
 * unsafe: plain HTTP to a non-loopback host, a tool argument that steers the
 * host into loopback, a redirect into loopback, or a remote manual/spec that
 * aims at the agent's own loopback. The SDK writes "Security error…" and
 * quotes the URL, so the message is matched by prefix and never re-emitted.
 */
const INSECURE_URL_PREFIX = "Security error";

function toolLabel(tool: string | undefined): string {
  return tool ? `tool '${displayText(tool, 120)}'` : "the UTCP tool";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Every transport timeout. The timer that fired does not show whether the
 * remote tool ran, so the outcome is always unknown, and the caller must not
 * retry a call that may mutate state.
 */
function transportTimeout(tool: string | undefined): ErrorBody {
  return {
    code: "TIMEOUT",
    message: `${toolLabel(tool)} timed out in the UTCP transport. The call may still have completed; check the remote side before retrying anything that mutates state.`,
    tool,
    outcome: "unknown",
  };
}

/**
 * Classifies an arbitrary thrown value into the adapter vocabulary.
 *
 * The thrown value is inspected only. Its message is deliberately discarded:
 * UTCP SDK and Axios messages can carry request URLs, auth headers and response
 * bodies (spec §7.5), so they must not reach a tool result or the adapter log.
 * Every message below is an adapter-written template that names the tool and
 * states the correction the caller or operator needs.
 */
export function classifyThrown(thrown: unknown, tool?: string): ErrorBody {
  if (thrown instanceof UtcpAdapterError) {
    const body = thrown.toBody();
    return body.tool || !tool ? body : { ...body, tool };
  }

  const candidate = thrown as
    | { isAxiosError?: unknown; code?: unknown; name?: unknown; response?: unknown; status?: unknown }
    | null;
  const message = readString((thrown as { message?: unknown })?.message);
  const code = readString(candidate?.code);
  const name = readString(candidate?.name);
  const prefix = message.slice(0, 64);

  const isAxios = candidate?.isAxiosError === true || typeof candidate?.response === "object";
  const hasStatus = typeof candidate?.status === "number";
  const isAbort = name === "AbortError" || code === "ERR_CANCELED";
  const isMcp = name === "McpError";
  const numericCode = typeof candidate?.code === "number" ? candidate.code : undefined;

  // MCP's request timeout is a JSON-RPC code, not a Node error code.
  if (isMcp && numericCode === -32001) {
    return transportTimeout(tool);
  }

  // A streamable-HTTP timeout aborts the fetch and surfaces as a DOMException
  // named `AbortError` with the message "The operation was aborted." The
  // adapter never passes an AbortSignal into the SDK, so an abort reaching this
  // classifier was raised by the transport's own timeout timer, not by a
  // caller: it is the "transport timeout" the spec allows to be reported.
  // Caller aborts are handled in `invoke()`, which returns outcome-unknown
  // before `classifyThrown` is ever consulted.
  if (isAbort && ABORT_AS_TIMEOUT_PATTERN.test(prefix)) {
    return transportTimeout(tool);
  }

  // A transport timeout is reported only from a structural signal.
  if (TIMEOUT_CODES.has(code) || TIMEOUT_NAME_PATTERN.test(name)) {
    return transportTimeout(tool);
  }
  if (!isAbort && TIMEOUT_MESSAGE_PREFIX.test(prefix)) {
    return transportTimeout(tool);
  }

  // `@utcp/http` refuses a URL it considers unsafe before sending anything.
  // This is an operator-fixable configuration problem, not a transport
  // failure, and it must never be retried.
  if (!isAbort && prefix.startsWith(INSECURE_URL_PREFIX)) {
    return {
      code: "CONFIGURATION_ERROR",
      message: `${toolLabel(tool)} was refused by the UTCP HTTP transport before any request was sent: the call template must use HTTPS, or plain HTTP only to a literal loopback host (localhost, 127.0.0.1, ::1), and a remote manual may not direct calls or token requests at loopback. Fix the manual's URL; retrying will not help.`,
      tool,
    };
  }

  // Pre-dispatch SDK failures: the call never reached the transport.
  if (
    !isAbort &&
    (SDK_CONFIGURATION_PREFIXES.some((lead) => prefix.startsWith(lead)) ||
      SDK_CONFIGURATION_PATTERNS.some((pattern) => pattern.test(prefix)))
  ) {
    return {
      code: "CONFIGURATION_ERROR",
      message: `${toolLabel(tool)} could not be prepared from its call template (missing variable or unresolvable manual). Fix the plugin's manual configuration; retrying will not help.`,
      tool,
    };
  }

  if (isMcp) {
    const serverSide = numericCode !== undefined && numericCode <= -32000;
    return {
      code: "TRANSPORT_ERROR",
      message: serverSide
        ? `${toolLabel(tool)} failed because the MCP server rejected or failed the call. The adapter did not retry; check the server's tool implementation, then retry only if the operation is safe to repeat.`
        : `${toolLabel(tool)} failed in the MCP transport session. Check that the manual's endpoint is reachable and that its parameters are accepted; the adapter did not retry.`,
      tool,
    };
  }

  if (isAxios || hasStatus || CONNECTIVITY_CODES.has(code)) {
    return {
      code: "TRANSPORT_ERROR",
      message: `${toolLabel(tool)} failed in the UTCP transport. Check that the manual's endpoint is reachable and that its parameters are accepted; the adapter did not retry.`,
      tool,
    };
  }

  // Anything unrecognised is an adapter-internal failure, never a transport claim.
  return {
    code: "INTERNAL_ERROR",
    message: `${toolLabel(tool)} failed with an unrecognised error inside the UTCP client. Check the plugin log; if it repeats, run describe to confirm the tool and report the adapter version.`,
    tool,
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
