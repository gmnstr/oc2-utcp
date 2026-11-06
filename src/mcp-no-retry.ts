import { CommunicationProtocol } from "@utcp/sdk";
import { McpCommunicationProtocol } from "@utcp/mcp";

/**
 * Removes the single automatic retry that `@utcp/mcp` performs for
 * session-class ("transient") failures.
 *
 * Why this exists
 * ---------------
 * Spec §8 forbids retrying a possibly mutating call, because the adapter
 * cannot know whether the first attempt reached the remote side. The MCP
 * protocol nevertheless re-runs the whole operation once when
 * `_classifySessionError()` reports `"transient"` (connection closed,
 * disconnected, ECONNRESET, "already initialized"). `callTool()` passes the
 * entire `client.callTool(...)` as that operation, so a mutating MCP tool can
 * execute twice. That is an acceptance blocker, not a documentation issue.
 *
 * How it is removed
 * -----------------
 * The SDK documents `CommunicationProtocol.communicationProtocolFactories` as
 * the public extension point for per-client protocol instances, and
 * `UtcpClient.create()` adopts a factory instance for each registered type
 * (a factory wins over a shared instance). We therefore register a factory
 * for `"mcp"` that returns this subclass. No SDK file is modified and no
 * process-global monkey patch is applied.
 *
 * What is relied upon
 * -------------------
 * The override calls the base class' internal helpers, because the retry
 * lives inside a private method and there is no configuration flag for it.
 * Each helper is checked at runtime before the factory is installed. When a
 * future SDK build renames or removes one, `checkProtocolSurface()` reports
 * `"unsupported"`, the factory is not installed, and the caller refuses every
 * MCP manual at startup (fail closed; see `initialize()` in plugin.ts). A
 * manual is never registered without the no-retry protocol.
 *
 * The surface check is a heuristic. Helper presence cannot show that the base
 * `callTool` still goes through `_withSession`, so the check also looks for
 * that name in the source of `callTool`. test/mcp-retry.test.ts is the real
 * guard: it executes a mutating tool through the installed protocol and counts
 * the executions on the server.
 */

const REQUIRED_HELPERS = [
  "_dereferenceSchema",
  "_sessionKey",
  "_getTimeoutMs",
  "_getOrCreateSession",
  "_withSession",
  "_runWithTimeout",
  "_classifySessionError",
  "_cleanupSession",
  "_invalidateOAuthToken",
] as const;

export type NoRetryInstallation = "installed" | "unsupported";

/** Result of inspecting the base protocol prototype before installation. */
export type ProtocolSurface = "supported" | "unsupported";

type HelperName = (typeof REQUIRED_HELPERS)[number];

/** Minimal structural view of the base class internals used by the override. */
interface McpInternals {
  _sessionKey(serverName: string, serverConfig: unknown, auth: unknown): string;
  _getTimeoutMs(serverConfig: unknown): number;
  _getOrCreateSession(serverName: string, serverConfig: unknown, auth: unknown): Promise<unknown>;
  _runWithTimeout(
    sessionKey: string,
    timeoutMs: number,
    client: unknown,
    operation: (client: never) => Promise<unknown>,
  ): Promise<unknown>;
  _classifySessionError(error: unknown): string | null;
  _cleanupSession(sessionKey: string, expected?: unknown): Promise<void>;
  _invalidateOAuthToken(auth: unknown): void;
  _dereferenceSchema(schema: unknown): Promise<unknown>;
}

type Operation = (client: never) => Promise<unknown>;

/**
 * Decides whether the base prototype exposes the surface the override needs.
 *
 * Pure: it reads the prototype and never installs anything, so tests can pass
 * fake prototypes. Missing helpers, or a `callTool` that does not route through
 * `_withSession`, mean the retry could not be removed safely.
 */
export function checkProtocolSurface(proto: object): ProtocolSurface {
  const record = proto as Record<string, unknown>;
  const helpersPresent = REQUIRED_HELPERS.every(
    (name: HelperName) => typeof record[name] === "function",
  );
  if (!helpersPresent) return "unsupported";

  // Heuristic: the base `callTool` must reach the session wrapper we override.
  // If it stopped doing so, overriding `_withSession` would do nothing.
  const callTool = record["callTool"];
  if (typeof callTool !== "function") return "unsupported";
  return Function.prototype.toString.call(callTool).includes("_withSession")
    ? "supported"
    : "unsupported";
}

let installation: NoRetryInstallation | null = null;
let previousFactory: (() => CommunicationProtocol) | undefined;
let hadPreviousFactory = false;

/**
 * Installs the no-retry MCP protocol factory once per process.
 *
 * Idempotent: repeated calls neither stack factories nor replace an
 * already-installed subclass with a different one.
 */
export function installNoRetryMcpProtocol(): NoRetryInstallation {
  if (installation !== null) return installation;

  if (checkProtocolSurface(McpCommunicationProtocol.prototype) === "unsupported") {
    installation = "unsupported";
    return installation;
  }

  // The retrying method is `private` in the base class, so TypeScript cannot
  // express the override through `extends McpCommunicationProtocol`. The
  // runtime object is still the real protocol -- this is a type-level widening
  // only, which is why the helper surface is verified before installation.
  type BaseProtocol = new (...args: never[]) => object;
  const Base = McpCommunicationProtocol as unknown as BaseProtocol;

  class NoRetryMcpCommunicationProtocol extends Base {
    /**
     * Same race as the base implementation, but the timeout error is named
     * `TimeoutError`. The base rejects with a plain `Error`, which
     * `classifyThrown` cannot recognise, so a timeout raised by this timer
     * would be reported as INTERNAL_ERROR. In practice the SDK's own request
     * timeout (`McpError` -32001, same duration, armed first) usually wins and
     * is already classified; this keeps the fallback path correct as well. The
     * message keeps the base wording, so `_classifySessionError` still sees
     * "timed out" and evicts the session.
     */
    async _runWithTimeout(
      sessionKey: string,
      timeoutMs: number,
      client: unknown,
      operation: Operation,
    ): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(client as never),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error(
                `MCP operation on '${sessionKey}' timed out after ${timeoutMs / 1e3}s.`,
              );
              error.name = "TimeoutError";
              reject(error);
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    private get internals(): McpInternals {
      return this as unknown as McpInternals;
    }

    /**
     * Turns off schema dereferencing during registration.
     *
     * The base implementation resolves `$ref`/`$defs` with
     * `$RefParser.dereference()`, whose default resolves *external* targets
     * too: a `file:` ref reads the host filesystem and an `http(s):` ref makes
     * the host issue the request. Both happen while a manual is being
     * registered -- before any permission check, before the adapter inspects
     * the schema and before any call is authorized -- and a malicious MCP
     * server chooses the schema. The adapter's own schema subset rejects
     * `$ref` and `$defs` outright, so dereferencing buys nothing here; it only
     * adds I/O the remote side controls.
     *
     * Returning the schema unchanged keeps the tool discoverable with
     * `schemaSupported: false` and renders it non-executable
     * (`SCHEMA_UNSUPPORTED`), which is the documented behaviour for an
     * unsupported keyword.
     */
    async _dereferenceSchema(schema: unknown): Promise<unknown> {
      return schema;
    }

    /**
     * Same session selection and timeout as the base implementation, without
     * the second attempt. Session-fatal outcomes still evict the session so a
     * later call dials fresh instead of reusing a dead transport.
     */
    async _withSession(
      serverName: string,
      serverConfig: unknown,
      auth: unknown,
      operation: Operation,
    ): Promise<unknown> {
      const helpers = this.internals;
      const sessionKey = helpers._sessionKey(serverName, serverConfig, auth);
      const timeoutMs = helpers._getTimeoutMs(serverConfig);
      let client: unknown;
      try {
        client = await helpers._getOrCreateSession(serverName, serverConfig, auth);
        return await helpers._runWithTimeout(sessionKey, timeoutMs, client, operation);
      } catch (error) {
        const classification = helpers._classifySessionError(error);
        // Every classified failure means the session itself is unusable:
        // evict it so a later call dials fresh. The base implementation does
        // the same before its retry; here there is no retry, only the eviction.
        if (classification !== null) {
          await helpers._cleanupSession(sessionKey, client).catch(() => undefined);
          if (classification === "auth") helpers._invalidateOAuthToken(auth);
        }
        throw error;
      }
    }
  }

  const factories = CommunicationProtocol.communicationProtocolFactories;
  const existing = factories["mcp"];
  previousFactory = existing;
  hadPreviousFactory = typeof existing === "function";
  factories["mcp"] = () => new NoRetryMcpCommunicationProtocol() as unknown as CommunicationProtocol;
  installation = "installed";
  return installation;
}

/**
 * Restores the protocol factory that was registered before installation.
 *
 * The factory map is process-global, so leaving our instance behind would make
 * every later UTCP client in this process suppress the retry as a side effect
 * of a plugin that is no longer loaded. Called from adapter teardown.
 */
export function uninstallNoRetryMcpProtocol(): void {
  if (installation !== "installed") return;
  const factories = CommunicationProtocol.communicationProtocolFactories as Record<
    string,
    (() => CommunicationProtocol) | undefined
  >;
  if (hadPreviousFactory && previousFactory !== undefined) {
    factories["mcp"] = previousFactory;
  } else {
    delete factories["mcp"];
  }
  installation = null;
  previousFactory = undefined;
  hadPreviousFactory = false;
}

/** Test seam: forget the installation result so a test can re-observe it. */
export function resetNoRetryInstallationForTest(): void {
  installation = null;
  previousFactory = undefined;
  hadPreviousFactory = false;
}
