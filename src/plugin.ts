/**
 * UTCP adapter core.
 *
 * Ownership: the adapter owns the OC2-facing interface, the capability
 * boundary, argument validation, authorization and result presentation. The
 * UTCP SDK owns discovery, tool definitions, protocol selection and execution.
 *
 * The catalog is compiled once, at readiness, and frozen. Nothing here
 * registers, deregisters or refreshes a manual after readiness (spec §9).
 */

import { readFileSync } from "node:fs";

import "@utcp/http";
import "@utcp/mcp";
import { UtcpClient } from "@utcp/sdk";
import type { Plugin } from "@opencode/plugin";
import type { CallTemplate, JsonSchema, Tool } from "@utcp/sdk";

import { compileToolPattern, loadConfig, matchesAnyPattern, type AdapterConfig } from "./config.js";
import { installNoRetryMcpProtocol, uninstallNoRetryMcpProtocol, type NoRetryInstallation } from "./mcp-no-retry.js";
import {
  classifyManual,
  classifyTool,
  isEnabled,
  normalizeCallTemplateType,
  type TransportClass,
} from "./transport.js";
import {
  compileSchema,
  probePatternWorker,
  refuseArgumentShape,
  terminatePatternWorkers,
  validateArgumentsGuarded,
  type CompiledSchema,
} from "./schema.js";
import { manualOf, toDescription, toListItem } from "./projection.js";
import { createLogger, type LogEvent, type Logger } from "./log.js";
import {
  classifyThrown,
  displayText,
  failure,
  isObject,
  waitDeadlineExpired,
  type ErrorBody,
  type FailureResult,
  type ManualStatus,
} from "./errors.js";

const NAMESPACE = "utcp";
const NAMESPACE_DESCRIPTION = "Discover and invoke UTCP capabilities";

/**
 * Bare tool names registered inside the `utcp` namespace, as spec §5 prescribes.
 * The host decides what those become: OC2 2.2.5 reports the bare names through
 * `ctx.tool.list()` and publishes `tools.utcp.<name>(…)` to the model, so the
 * spec's `utcp_*` effective names are not produced. Both spellings are accepted
 * here because the host, not the adapter, is authoritative.
 */
const OWNED_NAMES = ["search", "describe", "call"] as const;

/** The `utcp_*` spelling spec §3.1 predicts, kept as a fallback for hosts that prefix. */
const PREFIXED_NAMES = OWNED_NAMES.map((name) => `${NAMESPACE}_${name}`) as readonly string[];

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/**
 * Upper bound on each dispose wait: in-flight calls, the registration disposal,
 * the manual deregistration loop and the client close. None of them can be
 * cancelled, so an unbounded wait would hang the host's plugin unload behind a
 * transport or host hook that never answers. The bound applies per stage, so
 * dispose can take up to the sum of the stages in the worst case.
 */
const DEFAULT_DISPOSE_DEADLINE_MS = 10_000;

/**
 * Calls returned early and still unsettled allowed per manual with `waitMs`: calls
 * that expired at the deadline, and calls the caller aborted. The SDK cannot
 * cancel a call, so each one keeps its socket and promise alive until the
 * remote side answers. At the cap, new calls to that manual are refused
 * before dispatch, so a hung server cannot accumulate unbounded in-flight work.
 */
export const MAX_ABANDONED_PER_MANUAL = 8;

/**
 * Calls per manual with `waitMs` that are dispatched and not yet settled or
 * released: calls still waiting, plus abandoned calls whose slot has not been
 * released (see MAX_ABANDONED_PER_MANUAL). The slot is reserved synchronously at
 * dispatch, and this bounds the slots held, not the calls in flight: a slot is
 * released when its call settles or, for an abandoned call, when its hold ends
 * (ABANDON_HOLD_MS). The remote call may still be running after its hold ends, so
 * the calls in flight can exceed this. At most MAX_ABANDONED_PER_MANUAL (8) calls
 * per manual are held at once, so about 8 such released-while-running calls per
 * five minutes. At the limit a new call is refused before dispatch with TOOL_UNAVAILABLE.
 */
export const MAX_OUTSTANDING_PER_MANUAL = 32;

const OUTSTANDING_REFUSAL_MESSAGE =
  "This manual already has the maximum number of calls in progress or still running after their wait deadline, so this call was not sent. Retry in a few minutes.";

/**
 * How long an abandoned call holds its slot against MAX_ABANDONED_PER_MANUAL,
 * counted from the moment it was abandoned. A slot is released at the earlier
 * of this and the call settling. The promise stays tracked in `inflight` until
 * it settles, so dispose still accounts for it. A remote call that never
 * settles therefore stops blocking its manual after this long, but its socket
 * may remain open.
 */
export const ABANDON_HOLD_MS = 300_000;

/**
 * Sessions remembered by the policy-baseline probe. The probe runs once per
 * session, so the memo would otherwise grow for the life of the process.
 */
const MAX_POLICY_SESSIONS = 1024;

type LifecycleState = "initializing" | "ready" | "closing" | "closed";

/**
 * OC2 tool-facing types. The package root re-exports only `./plugin.js`, so
 * the editor and executor shapes are derived from `ctx.tool.transform` rather
 * than imported from a deep path the `exports` map does not guarantee.
 */
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];
type AddableTool = Parameters<ToolEditor["add"]>[0];
type ToolInputSchema = AddableTool["input"];
type ToolExecuteContext = Parameters<AddableTool["execute"]>[1];
type ToolExecuteResult = Awaited<ReturnType<AddableTool["execute"]>>;

const SEARCH_INPUT: ToolInputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Text matched against tool name, description and tags." },
    limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Maximum matches to return." },
  },
  required: ["query"],
  additionalProperties: false,
};

const DESCRIBE_INPUT: ToolInputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Exact UTCP tool name as returned by search." },
  },
  required: ["name"],
  additionalProperties: false,
};

const CALL_INPUT: ToolInputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Exact UTCP tool name as returned by search." },
    arguments: { type: "object", description: "Arguments validated against the tool's input schema." },
  },
  required: ["name"],
  additionalProperties: false,
};

interface CatalogEntry {
  /** The SDK tool object. Never returned to OC2 — only projections are. */
  tool: Tool;
  manual: string;
  manualClass: TransportClass;
  transport: TransportClass;
  /** Matched the configured tool allow patterns. */
  allowed: boolean;
  compiled: CompiledSchema;
  /**
   * Within the configured capability boundary: registered, transport enabled,
   * class consistent and matched by an allow pattern. Such a tool is always
   * discoverable and describable, even when its schema is unsupported.
   */
  discoverable: boolean;
  /** Discoverable and also validatable, i.e. callable. */
  executable: boolean;
}

export interface AdapterHooks {
  /** Operational log sink; defaults to `console.error` with a fixed prefix. */
  log?: (event: LogEvent) => void;
  /**
   * Best-effort policy baseline probe. Returns `no-rule` when no `utcp`
   * permission rule is configured at the plugin location. Diagnostic only.
   */
  policyBaseline?: (directory: string | undefined) => "rule" | "no-rule" | "unknown";
  /**
   * Installation of the no-retry MCP protocol. Defaults to the real
   * `installNoRetryMcpProtocol()`; tests inject `() => "unsupported"` to
   * exercise the fail-closed path deterministically.
   */
  installMcpProtocol?: () => NoRetryInstallation;
  /** Bound on each dispose wait (in-flight calls, client close). Tests lower it. */
  disposeDeadlineMs?: number;
  /** How long an abandoned call holds its cap slot (ABANDON_HOLD_MS). Tests lower it. */
  abandonHoldMs?: number;
}

interface CallContext {
  sessionID: string;
  agent?: string;
  messageID?: string;
  id?: string;
  signal?: AbortSignal;
  progress?: (metadata: Record<string, unknown>) => Promise<void>;
}

const ABORTED = Symbol("aborted");
const WAIT_EXPIRED = Symbol("waitExpired");

let ACTIVE: UtcpAdapter | null = null;

export class UtcpAdapter {
  private readonly ctx: Plugin.Context;
  private readonly hooks: AdapterHooks;
  private readonly logger: Logger;
  private readonly toolPatterns: RegExp[] = [];
  private state: LifecycleState = "initializing";
  private config: AdapterConfig | null = null;
  private client: UtcpClient | null = null;
  private registration: { dispose: () => Promise<void> } | null = null;
  private catalog = new Map<string, CatalogEntry>();
  private manuals: ManualStatus[] = [];
  private registeredManuals: string[] = [];
  private effectiveNames: readonly string[] = [];
  private readonly inflight = new Set<Promise<unknown>>();
  /** Insertion-ordered; the oldest session is evicted past MAX_POLICY_SESSIONS. */
  private readonly policyChecked = new Set<string>();
  /** Per-manual `waitMs` bound, keyed by the registered manual name. Never sent to the SDK. */
  private readonly waitMsByManual = new Map<string, number>();
  /** Dispatched-but-unreleased calls per manual with `waitMs` (see MAX_OUTSTANDING_PER_MANUAL). */
  private readonly outstandingByManual = new Map<string, number>();
  /** Expired-but-unsettled calls per manual; each slot is released at settle or at the hold deadline. */
  private readonly abandonedByManual = new Map<string, number>();
  /** Hold timers of abandoned slots not yet released; cleared on settle and in dispose. */
  private readonly abandonHoldTimers = new Set<ReturnType<typeof setTimeout>>();
  private mcpRetrySuppressed = false;
  private initError: ErrorBody | null = null;

  constructor(ctx: Plugin.Context, hooks: AdapterHooks = {}) {
    this.ctx = ctx;
    this.hooks = hooks;
    this.logger = createLogger(hooks.log);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.logger.emit({ event: "lifecycle", phase: "initializing" });

    const loaded = loadConfig(this.ctx.options, this.ctx.location?.directory);
    if (!loaded.ok) {
      this.initError = loaded.error;
      // Spec §9 lists four states and no fifth. A startup that fails owns no
      // resources and never becomes ready, so it reports `closed`; the reason
      // stays in `initError` and in the event detail rather than in a state
      // the host's state machine does not know.
      this.state = "closed";
      this.logger.emit({ event: "lifecycle", phase: "closed", detail: loaded.error.code });
      return;
    }

    this.config = loaded.config;
    for (const pattern of this.config.toolPatterns) {
      this.toolPatterns.push(compileToolPattern(pattern));
    }

    try {
      await this.initialize();
    } catch (error) {
      await this.failStartup(classifyThrown(error));
      return;
    }

    // One pattern-worker probe per startup, before readiness. It is bounded by
    // its own deadline and never throws; a false result is reported, not fatal.
    const patternGuardAvailable = await probePatternWorker();
    this.logger.emit({ event: "config", notice: "patternGuard", available: patternGuardAvailable });

    try {
      await this.registerTools();
    } catch (error) {
      // An exception from the transform callback or from `ctx.tool.list()`
      // would otherwise escape `setup()` with ACTIVE set, the MCP factory
      // installed and the client open. Roll the partial setup back first.
      await this.failStartup(classifyThrown(error));
    }
  }

  /**
   * Records a startup failure and releases everything the attempt acquired.
   * The adapter stays non-ready and no tools are registered, so nothing runs;
   * a call that still reaches the adapter before registration finishes gets
   * `TOOL_UNAVAILABLE` from the readiness gate, not the startup error.
   */
  private async failStartup(error: ErrorBody): Promise<void> {
    this.initError = error;
    this.state = "closed";
    this.logger.emit({ event: "lifecycle", phase: "closed", detail: error.code });

    const registration = this.registration;
    this.registration = null;
    if (registration !== null) {
      try {
        await registration.dispose();
      } catch {
        // Cleanup is best effort; the failure above is the reportable one.
      }
    }

    await this.closeClient();

    if (this.mcpRetrySuppressed) {
      uninstallNoRetryMcpProtocol();
      this.mcpRetrySuppressed = false;
    }
  }

  private async initialize(): Promise<void> {
    const config = this.config;
    if (config === null) throw new Error("configuration missing");

    // Registration-time retry suppression for MCP manuals. `@utcp/mcp`
    // re-runs a whole tool call once after a session-class failure, which
    // can execute a mutating tool twice (spec §8 forbids this). The factory
    // installed here replaces that retrying path; see mcp-no-retry.ts.
    const hasMcpManual = config.manuals.some((template) => {
      const transport = classifyManual(template);
      return transport === "mcp-http" || transport === "mcp-stdio";
    });
    let mcpRetryUnavailable = false;
    if (hasMcpManual) {
      const installMcpProtocol = this.hooks.installMcpProtocol ?? installNoRetryMcpProtocol;
      const installation = installMcpProtocol();
      if (installation === "unsupported") {
        // Fail closed. The stock protocol re-runs a failed MCP call once,
        // which can execute a mutating tool twice (spec §8). Registering the
        // manual anyway would claim a safety property this build cannot
        // enforce, so the manual is refused and the refusal is reported.
        mcpRetryUnavailable = true;
        this.logger.emit({
          event: "lifecycle",
          phase: "initializing",
          detail: "mcpRetrySuppressionUnavailable",
        });
      } else {
        this.mcpRetrySuppressed = true;
      }
    }

    // Step 3: client with no manuals. `create()` would otherwise register
    // `config.manual_call_templates` and discard every result. Passing `null`
    // selects the SDK's own defaults, which contain no manuals, so registration
    // happens exactly once below, with every result inspected.
    const client = await UtcpClient.create(config.rootDir, null);
    this.client = client;

    // Step 2: classify, drop disabled classes before anything is registered.
    const candidates: { template: CallTemplate; transport: TransportClass; name: string; waitMs?: number }[] = [];
    for (const template of config.manuals) {
      const transport = classifyManual(template);
      const name = manualNameFromTemplate(template);
      if (mcpRetryUnavailable && (transport === "mcp-http" || transport === "mcp-stdio")) {
        this.manuals.push({
          name,
          transport,
          registered: false,
          success: false,
          reason:
            "The installed @utcp/mcp retries a failed MCP call once and the adapter could not install its no-retry protocol; the manual was not registered to avoid executing a mutating tool twice.",
          tools: 0,
        });
        continue;
      }
      if (!isEnabled(transport, config.transports)) {
        this.manuals.push({
          name,
          transport,
          registered: false,
          success: false,
          reason: `Transport class '${transport}' is disabled; the manual was not registered.`,
          tools: 0,
        });
        continue;
      }
      // `waitMs` is the adapter's own option (validated in loadConfig). It is
      // stripped here so the SDK never receives a key it does not define.
      const { waitMs, ...sdkTemplate } = template as CallTemplate & { waitMs?: unknown };
      candidates.push({
        template: sdkTemplate as CallTemplate,
        transport,
        name,
        waitMs: typeof waitMs === "number" ? waitMs : undefined,
      });
    }

    // Only streamable_http honours `timeout`. http and sse templates accept the
    // key and then ignore it, so an operator who sets it gets no effect. Report
    // it once per manual, whether or not the manual also has a `waitMs` bound:
    // `timeout` is ignored in both cases. The value itself is not logged.
    for (const candidate of candidates) {
      const type = normalizeCallTemplateType(candidate.template.call_template_type);
      if ((type === "http" || type === "sse") && "timeout" in candidate.template) {
        this.logger.emit({ event: "config", notice: "timeoutIgnored", manual: candidate.name, template: type });
      }
    }

    // Step 4: explicit registration, every result inspected.
    const results = await client.registerManuals(candidates.map((candidate) => candidate.template));

    results.forEach((result, index) => {
      const candidate = candidates[index];
      if (candidate === undefined) return;
      const name = displayText(result.manualCallTemplate?.name ?? candidate.name, 120);
      if (result.success) {
        this.registeredManuals.push(name);
        candidate.name = name;
        if (candidate.waitMs !== undefined) this.waitMsByManual.set(name, candidate.waitMs);
        this.manuals.push({
          name,
          transport: candidate.transport,
          registered: true,
          success: true,
          tools: 0,
        });
      } else {
        // Never repeat SDK error text: it can carry URLs and response bodies.
        this.manuals.push({
          name,
          transport: candidate.transport,
          registered: false,
          success: false,
          reason:
            "The UTCP SDK could not register this manual at startup. Check its configuration and reachability; retrying this call will not help.",
          tools: 0,
        });
      }
    });

    // Step 5: compile the capability boundary and every schema verdict.
    const byName = new Map(this.manuals.map((status) => [status.name, status]));
    const byTemplate = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    const tools = await client.getTools();

    for (const tool of tools) {
      const manual = manualOf(tool);
      const status = byName.get(manual);
      if (status === undefined || !status.success) continue;

      const candidate = byTemplate.get(manual);
      const manualClass = candidate?.transport ?? "unclassified";
      const transport = classifyTool(tool, candidate?.template);
      const allowed = matchesAnyPattern(tool.name, this.toolPatterns);
      const compiled = compileSchema(tool.inputs ?? {});
      const discoverable =
        allowed &&
        isEnabled(transport, this.config!.transports) &&
        transport === manualClass;
      const executable = discoverable && compiled.check.supported && typeof compiled.validate === "function";

      this.catalog.set(tool.name, {
        tool,
        manual,
        manualClass,
        transport,
        allowed,
        compiled,
        discoverable,
        executable,
      });

      if (executable) status.tools += 1;
    }

    // Manual summary logs are emitted after the catalog is compiled so
    // `toolCount` reports the number of executable tools, not a placeholder.
    for (const status of this.manuals) {
      this.logger.emit({
        event: "manual",
        name: status.name,
        transport: status.transport,
        registered: status.registered,
        toolCount: status.tools,
      });
    }
  }

  private async registerTools(): Promise<void> {
    const transform = this.ctx.tool?.transform;
    if (typeof transform !== "function") {
      await this.failStartup({
        code: "CONFIG_INVALID",
        message: "This OpenCode build does not expose ctx.tool.transform; the plugin cannot register its tools.",
      });
      return;
    }

    // The callback is synchronous and replay-safe: all initialization happened
    // above and the catalog is frozen, so a reload replay sees the same tools.
    //
    // Registration form: declare the `utcp` namespace, then add
    // the bare names `search`, `describe`, `call` with `options.namespace`.
    // Measured on the installed host (OC2 2.2.5) with test/host/probe-forms.ts and
    // test/host/dump-bodies.ts:
    //   namespace + bare names        -> ctx.tool.list(): search, describe, call
    //                                    model catalog: tools.utcp.search(...)
    //   namespace + prefixed names    -> ctx.tool.list(): utcp_search, ...
    //                                    model catalog: tools.utcp.utcp_search(...)
    //   no namespace + prefixed names -> ctx.tool.list(): utcp_search, ...
    //                                    model catalog: tools.utcp_search(...)
    // The host is authoritative (§3.1, §5). This build therefore does not produce
    // the `utcp_*` effective names §3.1/§11 predict; that criterion is reported as
    // unmet rather than emulated by a form §5 does not prescribe.
    const registration = await transform((editor) => {
      editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION });

      editor.add({
        name: "search",
        description:
          "Search configured UTCP tools by name, description or tags. Returns names and short descriptions only; use describe for schemas.",
        input: SEARCH_INPUT,
        options: { namespace: NAMESPACE, codemode: true },
        execute: async (input: unknown, context: ToolExecuteContext) =>
          this.wrap(await this.search(input, toCallContext(context))),
      });

      editor.add({
        name: "describe",
        description:
          "Show a UTCP tool's authoritative input and output schema, transport class and schema support verdict.",
        input: DESCRIBE_INPUT,
        options: { namespace: NAMESPACE, codemode: true },
        execute: async (input: unknown, context: ToolExecuteContext) =>
          this.wrap(await this.describe(input, toCallContext(context))),
      });

      editor.add({
        name: "call",
        description:
          "Invoke a UTCP tool by exact name. Arguments are validated against the tool's schema before any permission check or network call.",
        input: CALL_INPUT,
        options: { namespace: NAMESPACE, codemode: true },
        execute: async (input: unknown, context: ToolExecuteContext) =>
          this.wrap(await this.call(input, toCallContext(context))),
      });
    });

    this.registration = registration;

    // Effective names are whatever the host reports; never assume them. The
    // namespace form is measured to yield the bare names on OC2 2.2.5, and the
    // `utcp_*` spelling is still honoured for a host that prefixes instead.
    const listed = await this.ctx.tool.list();
    const present = new Set(listed.map((info) => info.name));
    this.effectiveNames = OWNED_NAMES.flatMap((name, index) => {
      if (present.has(name)) return [name];
      const prefixed = PREFIXED_NAMES[index];
      return prefixed !== undefined && present.has(prefixed) ? [prefixed] : [];
    });

    if (this.effectiveNames.length !== OWNED_NAMES.length) {
      const missing = OWNED_NAMES.filter((name, index) => {
        const prefixed = PREFIXED_NAMES[index];
        return !present.has(name) && (prefixed === undefined || !present.has(prefixed));
      });
      await this.failStartup({
        code: "CONFIG_INVALID",
        message: `OpenCode did not expose the expected tool name(s): ${missing.join(", ")}.`,
      });
      return;
    }

    this.state = "ready";
    this.logger.emit({ event: "lifecycle", phase: "ready", detail: this.effectiveNames.join(",") });
  }

  async dispose(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return;
    this.state = "closing";
    this.logger.emit({ event: "lifecycle", phase: "closing" });

    // Pattern validations still running are stopped here. This is synchronous
    // and each one settles at once as a refusal, so it adds no wait. A stopped
    // call returns a validation failure and is never dispatched.
    terminatePatternWorkers();

    // Hold timers are cleared here. Each abandoned call still releases its slot
    // when its promise settles, and the `released` flag keeps that to one release.
    for (const timer of this.abandonHoldTimers) clearTimeout(timer);
    this.abandonHoldTimers.clear();

    // Calls already dispatched cannot be cancelled (the SDK takes no signal);
    // account for them rather than claiming they stopped. The wait is bounded
    // so a call that never answers cannot hang the unload; an abandoned call is
    // reported as such and is not claimed to have stopped.
    if (this.inflight.size > 0) {
      const settled = await withinDeadline(
        Promise.allSettled([...this.inflight]),
        this.disposeDeadlineMs(),
      );
      if (!settled) {
        this.logger.emit({
          event: "lifecycle",
          phase: "closing",
          detail: `inflightAbandoned:${this.inflight.size}`,
        });
      }
    }

    // Each stage below is bounded like the in-flight wait and the client close.
    // A host teardown or a deregistration that never settles must not hold the
    // unload. An expired stage is reported and not claimed to have stopped; the
    // next stage still runs, so the client is still closed.
    const registration = this.registration;
    this.registration = null;
    if (registration !== null) {
      // The async wrapper turns a synchronous throw into a rejection, which
      // withinDeadline then treats as settled. Registration disposal is
      // best-effort; unloading the plugin also disposes it.
      const disposed = await withinDeadline(
        (async () => registration.dispose())(),
        this.disposeDeadlineMs(),
      );
      if (!disposed) {
        this.logger.emit({ event: "lifecycle", phase: "closing", detail: "registrationDisposeTimedOut" });
      }
    }

    const manuals = this.registeredManuals;
    this.registeredManuals = [];
    if (manuals.length > 0) {
      // One deadline covers the whole loop. Each deregistration's failure is
      // ignored; `close()` below releases the client's owned protocols.
      const deregistered = await withinDeadline(
        (async () => {
          for (const name of manuals) {
            try {
              await this.client?.deregisterManual(name);
            } catch {
              // Continue with the next manual.
            }
          }
        })(),
        this.disposeDeadlineMs(),
      );
      if (!deregistered) {
        this.logger.emit({ event: "lifecycle", phase: "closing", detail: "deregisterTimedOut" });
      }
    }

    await this.closeClient();

    if (this.mcpRetrySuppressed) {
      uninstallNoRetryMcpProtocol();
      this.mcpRetrySuppressed = false;
    }

    this.state = "closed";
    this.logger.emit({ event: "lifecycle", phase: "closed" });
    if (ACTIVE === this) ACTIVE = null;
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client === null) return;
    try {
      // Bounded: an MCP session whose cleanup never finishes must not keep the
      // plugin loaded. The close is left running; it is not claimed to be done.
      const closed = await withinDeadline(client.close(), this.disposeDeadlineMs());
      if (!closed) {
        this.logger.emit({ event: "lifecycle", phase: "closing", detail: "closeTimedOut" });
      }
    } catch {
      // A failing close must not keep the plugin loaded.
    }
  }

  private disposeDeadlineMs(): number {
    return this.hooks.disposeDeadlineMs ?? DEFAULT_DISPOSE_DEADLINE_MS;
  }

  private abandonHoldMs(): number {
    return this.hooks.abandonHoldMs ?? ABANDON_HOLD_MS;
  }

  /** Diagnostics for tests and operators; never contains credentials. */
  status(): {
    state: LifecycleState;
    effectiveNames: readonly string[];
    manuals: readonly ManualStatus[];
    tools: readonly string[];
    error: ErrorBody | null;
  } {
    return {
      state: this.state,
      effectiveNames: this.effectiveNames,
      manuals: this.manuals,
      tools: [...this.catalog.values()].filter((entry) => entry.executable).map((entry) => entry.tool.name),
      error: this.initError,
    };
  }

  // ------------------------------------------------------------------- tools

  private wrap(result: unknown): ToolExecuteResult {
    return { content: JSON.stringify(result) };
  }

  private gate(): FailureResult | null {
    if (this.state === "ready") return null;
    const retryable = this.state === "initializing";
    return failure({
      code: "TOOL_UNAVAILABLE",
      message: retryable
        ? "UTCP is still starting; retry once the manuals have registered."
        : "UTCP is not available in this session (the plugin is closing or failed to start).",
      retryable,
    });
  }

  private async search(input: unknown, context: CallContext): Promise<unknown> {
    const gate = this.gate();
    if (gate !== null) return gate;

    try {
      const raw = isObject(input) ? input : {};
      const query = typeof raw.query === "string" ? raw.query : "";
      if (query.trim().length === 0) {
        return failure({
          code: "INVALID_ARGUMENTS",
          message: "`query` must be a non-empty string.",
          path: "arguments.query",
          expected: "non-empty string",
          received: describeReceived(raw.query),
        });
      }

      const limit = normalizeLimit(raw.limit);
      const client = this.client;
      if (client === null) return this.unavailable();

      // `limit = 0` returns every scored tool; the capability boundary decides
      // what is visible, not the SDK's default page size.
      const scored = await client.searchTools(query, 0);
      const matches = [];
      for (const tool of scored) {
        if (matches.length >= limit) break;
        const entry = this.catalog.get(tool.name);
        if (entry === undefined || !entry.discoverable) continue;
        matches.push(toListItem(tool, entry.transport));
      }
      return { ok: true, matches };
    } catch (error) {
      return failure(classifyThrown(error));
    }
  }

  private async describe(input: unknown, _context: CallContext): Promise<unknown> {
    const gate = this.gate();
    if (gate !== null) return gate;

    try {
      const raw = isObject(input) ? input : {};
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (name.length === 0) {
        return failure({
          code: "INVALID_ARGUMENTS",
          message: "`name` must be a non-empty string.",
          path: "arguments.name",
          expected: "non-empty string",
          received: describeReceived(raw.name),
        });
      }

      const entry = this.catalog.get(name);
      if (entry === undefined) return this.unknownTool(name);
      if (!entry.discoverable) {
        return failure({
          code: "TOOL_NOT_ALLOWED",
          message: `Tool '${displayText(name, 120)}' is not permitted by this plugin's configuration.`,
          tool: entry.tool.name,
        });
      }

      return { ok: true, tool: toDescription(entry.tool, entry.transport, entry.compiled.check) };
    } catch (error) {
      return failure(classifyThrown(error));
    }
  }

  private async call(
    input: unknown,
    context: CallContext,
  ): Promise<unknown> {
    const gate = this.gate();
    if (gate !== null) return gate;

    const prepared = await this.prepareCall(input, context);
    if (prepared.ok === false) return prepared;

    // Permission errors must propagate natively: they are not tool output.
    await this.assertPermission(prepared.entry, context);

    // The permission prompt can outlast dispose(). The gate above is stale by
    // now, and dispose's in-flight snapshot was taken before this call existed,
    // so readiness is checked again here, with no await between this check and
    // the dispatch in invoke(). A call admitted after closing starts is refused.
    const stillReady = this.gate();
    if (stillReady !== null) return stillReady;

    return this.invoke(prepared.entry, prepared.args, context);
  }

  private async prepareCall(
    input: unknown,
    context: CallContext,
  ): Promise<FailureResult | { ok: true; entry: CatalogEntry; args: Record<string, unknown> }> {
    const raw = isObject(input) ? input : {};
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length === 0) {
      return failure({
        code: "INVALID_ARGUMENTS",
        message: "`name` must be a non-empty string.",
        path: "arguments.name",
        expected: "non-empty string",
        received: describeReceived(raw.name),
      });
    }

    // Spec §3.4 orders resolution and rejection before argument shape checks:
    // an unknown name must read as UNKNOWN_TOOL even when the arguments are
    // also malformed, because the caller's first problem is not the arguments.
    const entry = this.catalog.get(name);
    if (entry === undefined) return this.unknownTool(name);

    // Capability boundary, re-resolved from the frozen entry.
    if (
      !entry.allowed ||
      this.config === null ||
      !isEnabled(entry.transport, this.config.transports) ||
      entry.transport !== entry.manualClass
    ) {
      return failure({
        code: "TOOL_NOT_ALLOWED",
        message: `Tool '${displayText(entry.tool.name, 120)}' is not permitted by this plugin's configuration.`,
        tool: entry.tool.name,
      });
    }

    if (!entry.compiled.check.supported) {
      const first = entry.compiled.check.issues[0];
      return failure({
        code: "SCHEMA_UNSUPPORTED",
        message:
          "The tool's input schema uses constructs this adapter cannot validate safely, so the tool is not executable.",
        tool: entry.tool.name,
        path: first?.path,
        keyword: first?.keyword,
        issues: entry.compiled.check.issues,
      });
    }

    if (typeof entry.compiled.validate !== "function") {
      return failure({
        code: "SCHEMA_UNSUPPORTED",
        message: "The tool's input schema could not be compiled, so the tool is not executable.",
        tool: entry.tool.name,
      });
    }

    // Spec §3.4: the arguments object is forwarded "without semantic
    // transformation". A missing property means "no arguments"; an explicit
    // `null` is a value the caller sent and is rejected, not silently replaced
    // with `{}`, which would execute the tool with defaults it never received.
    const rawArgs = raw.arguments === undefined ? {} : raw.arguments;
    if (!isObject(rawArgs)) {
      return failure({
        code: "INVALID_ARGUMENTS",
        message: "`arguments` must be a JSON object.",
        tool: displayText(entry.tool.name, 120),
        path: "arguments.arguments",
        expected: "object",
        received: describeReceived(rawArgs),
      });
    }

    // Validation and dispatch use this one copy. The copy is taken before the
    // first await, so a getter, proxy or caller mutation during the await cannot
    // make the dispatched arguments differ from the validated ones.
    let snapshot: Record<string, unknown>;
    try {
      // Depth and value count are measured on the caller's object first, so an
      // adversarial shape is refused before it reaches structuredClone.
      const shape = refuseArgumentShape(rawArgs);
      if (shape !== undefined && shape.ok === false) {
        return failure({
          code: "VALIDATION_FAILED",
          message: shape.message,
          tool: entry.tool.name,
          path: shape.path,
          expected: shape.expected,
          received: shape.received,
        });
      }
      snapshot = structuredClone(rawArgs) as Record<string, unknown>;
    } catch {
      return failure({
        code: "INVALID_ARGUMENTS",
        message: "`arguments` could not be copied for validation, so the call was not sent.",
        tool: displayText(entry.tool.name, 120),
        path: "arguments.arguments",
        expected: "plain data object",
        received: "uncopyable object",
      });
    }

    // Pattern schemas are validated in a worker with a deadline (see schema.ts);
    // this await is the only point where validation leaves the host thread.
    const validation = await validateArgumentsGuarded(entry.compiled, snapshot);
    if (validation.ok === false) {
      return failure({
        code: "VALIDATION_FAILED",
        message: validation.message,
        tool: entry.tool.name,
        path: validation.path,
        expected: validation.expected,
        received: validation.received,
      });
    }

    this.notePolicyBaseline(context);
    return { ok: true, entry, args: snapshot };
  }

  private async assertPermission(entry: CatalogEntry, context: CallContext): Promise<void> {
    const resource = entry.tool.name;
    const save = /^[A-Za-z0-9_.\-]+$/.test(resource) ? [resource] : undefined;
    await this.ctx.permission.assert({
      sessionID: context.sessionID as never,
      agent: context.agent as never,
      source: { type: "tool", messageID: context.messageID ?? "", id: context.id ?? "" },
      action: "utcp",
      resources: [resource],
      ...(save === undefined ? {} : { save }),
    });
  }

  private async invoke(
    entry: CatalogEntry,
    args: Record<string, unknown>,
    context: CallContext,
  ): Promise<unknown> {
    const client = this.client;
    if (client === null) return this.unavailable();

    const invocationID = crypto.randomUUID();
    const startedAt = Date.now();
    const name = entry.tool.name;

    // A signal aborted before dispatch means the caller has already gone. The
    // SDK call would still run, so refuse here. The call did not run, so this
    // is not the "outcome unknown" case below.
    if (context.signal?.aborted) {
      this.logCall(entry, context, invocationID, Date.now() - startedAt, false, "INTERNAL_ERROR");
      return failure({
        code: "INTERNAL_ERROR",
        message:
          "The OC2 context aborted before dispatch, so the UTCP call was not sent and did not run.",
        tool: name,
      });
    }

    // Two bounds, both checked before dispatch. Each counts only calls to a manual
    // with `waitMs` (other manuals never have entries). At either limit the call is
    // refused before anything is sent, so this is not an outcome-unknown result.
    // The outstanding bound counts every dispatched call not yet released, waiting
    // and abandoned alike. The abandoned bound counts calls returned early that are
    // still running remotely.
    const waitMs = this.waitMsByManual.get(entry.manual);
    if ((this.outstandingByManual.get(entry.manual) ?? 0) >= MAX_OUTSTANDING_PER_MANUAL) {
      this.logCall(entry, context, invocationID, Date.now() - startedAt, false, "TOOL_UNAVAILABLE");
      return failure({
        code: "TOOL_UNAVAILABLE",
        message: OUTSTANDING_REFUSAL_MESSAGE,
        tool: name,
        retryable: true,
      });
    }
    if ((this.abandonedByManual.get(entry.manual) ?? 0) >= MAX_ABANDONED_PER_MANUAL) {
      this.logCall(entry, context, invocationID, Date.now() - startedAt, false, "TOOL_UNAVAILABLE");
      return failure({
        code: "TOOL_UNAVAILABLE",
        message:
          "This manual already has the maximum number of calls still running after their wait deadline, so this call was not sent. Retry in a few minutes.",
        tool: name,
        retryable: true,
      });
    }

    if (typeof context.progress === "function") {
      // Progress is advisory and is not awaited: a hook that never settles must
      // not hold the call before dispatch, and nothing here can cancel it. It is
      // still started before callTool, and its rejection is swallowed.
      try {
        void Promise.resolve(context.progress({ status: "running", tool: name })).catch(() => undefined);
      } catch {
        // A synchronous throw from the hook is advisory too.
      }
    }

    // The slot is reserved here, synchronously and before callTool, so the count
    // never lags a dispatch. A manual without `waitMs` has no slot.
    const slot = waitMs === undefined ? undefined : this.reserveSlot(entry.manual);

    // `callTool` takes no AbortSignal, so this promise is the only handle on the
    // transport work; it is tracked so cleanup can account for it.
    let pending: Promise<unknown>;
    try {
      pending = client.callTool(name, args);
    } catch (error) {
      slot?.release();
      throw error;
    }
    this.inflight.add(pending);
    let settled = false;
    const markSettled = () => {
      settled = true;
      this.inflight.delete(pending);
      slot?.release();
    };
    pending.then(markSettled, markSettled);

    let outcome: unknown;
    let aborted = false;
    const signal = context.signal;
    const onAbort = () => {
      aborted = true;
    };
    // The race's own listener is named so it can be detached when the transport
    // wins: an anonymous listener would stay attached to the host's session
    // signal for the rest of the process, one per completed call.
    let onRaceAbort: (() => void) | undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    const abortRace = new Promise<typeof ABORTED>((resolve) => {
      if (signal?.aborted) {
        aborted = true;
        resolve(ABORTED);
        return;
      }
      onRaceAbort = () => resolve(ABORTED);
      signal?.addEventListener("abort", onRaceAbort, { once: true });
    });

    // Bounded wait (`waitMs`, http and sse only). Armed after dispatch, cleared
    // on every exit path below. The timer is unref'd so it never keeps the host
    // process alive by itself.
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const waitExpired =
      waitMs === undefined
        ? undefined
        : new Promise<typeof WAIT_EXPIRED>((resolve) => {
            waitTimer = setTimeout(() => resolve(WAIT_EXPIRED), waitMs);
            waitTimer.unref();
          });
    const racers: Promise<unknown>[] = [pending, abortRace];
    if (waitExpired !== undefined) racers.push(waitExpired);

    try {
      outcome = await Promise.race(racers);
    } catch (error) {
      // The SDK call cannot be cancelled; swallow a late rejection so an
      // abandoned call never becomes an unhandled rejection.
      pending.catch(() => {});
      const durationMs = Date.now() - startedAt;
      const body = classifyThrown(error, name);
      this.logCall(entry, context, invocationID, durationMs, false, body.code);
      return failure(body);
    } finally {
      clearTimeout(waitTimer);
      signal?.removeEventListener("abort", onAbort);
      if (onRaceAbort !== undefined) signal?.removeEventListener("abort", onRaceAbort);
    }

    // The SDK call cannot be cancelled; swallow a late rejection so an
    // abandoned call never becomes an unhandled rejection.
    pending.catch(() => {});

    const durationMs = Date.now() - startedAt;

    // A call returned to the caller before it settled (expired at waitMs, or
    // abandoned by the caller's abort) still runs remotely. For a manual with
    // waitMs it counts against the cap until it settles. Other manuals are unchanged.
    const returnedEarly = outcome === WAIT_EXPIRED || aborted || outcome === ABORTED;
    if (slot !== undefined && returnedEarly && !settled) slot.abandon();

    // Race outcome: a call that completes exactly at the deadline may still be
    // reported here as TIMEOUT with outcome unknown, because the race can pick the
    // timer over a result that is one tick behind it. That is conservative: the
    // caller is told the outcome is unknown, and nothing is retried.
    if (outcome === WAIT_EXPIRED && waitMs !== undefined) {
      // The adapter stops waiting; the call is not cancelled. It stays in
      // `inflight` until it settles, and counts against the cap until then.
      this.logCall(entry, context, invocationID, durationMs, false, "TIMEOUT", waitMs);
      return failure(waitDeadlineExpired(name, waitMs));
    }

    if (aborted || outcome === ABORTED) {
      this.logCall(entry, context, invocationID, durationMs, false, "INTERNAL_ERROR");
      return failure({
        code: "INTERNAL_ERROR",
        outcome: "unknown",
        message:
          "Outcome unknown: the OC2 context aborted while the UTCP call was in flight. The adapter does not cancel transports, so the remote side may still have executed it.",
        tool: name,
      });
    }

    // Never inspect the remote result's shape: `callTool` returns whatever the
    // remote tool produced, and a `{ok:false,error}` payload from a remote tool
    // is data, not an adapter envelope. Treating it as one would leak a
    // non-vocabulary code and mislabel a completed call as a failure.
    this.logCall(entry, context, invocationID, durationMs, true, undefined);
    return { ok: true, result: outcome };
  }

  private logCall(
    entry: CatalogEntry,
    context: CallContext,
    invocationID: string,
    durationMs: number,
    ok: boolean,
    code: string | undefined,
    waitMs?: number,
  ): void {
    this.logger.emit({
      event: "call",
      tool: entry.tool.name,
      manual: entry.manual,
      transport: entry.transport,
      durationMs,
      ok,
      ...(code === undefined ? {} : { code }),
      ...(waitMs === undefined ? {} : { timedOut: true, waitMs }),
      sessionID: context.sessionID,
      invocationID,
    });
  }

  /**
   * Reserves one slot against the manual's outstanding bound for a call that is
   * about to be dispatched. `release` frees it once: when the call settles, or when
   * the hold of an abandoned call ends. `abandon` marks a call the adapter returned
   * to its caller before it settled (expired at waitMs, or aborted by the caller).
   * An abandoned call also counts against MAX_ABANDONED_PER_MANUAL until it is
   * released, and its hold timer releases it at ABANDON_HOLD_MS if it has not
   * settled by then. The `released` flag makes the release happen once.
   */
  private reserveSlot(manual: string): { release: () => void; abandon: () => void } {
    this.adjustCount(this.outstandingByManual, manual, 1);
    let released = false;
    let abandoned = false;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (holdTimer !== undefined) {
        clearTimeout(holdTimer);
        this.abandonHoldTimers.delete(holdTimer);
      }
      this.adjustCount(this.outstandingByManual, manual, -1);
      if (abandoned) this.adjustCount(this.abandonedByManual, manual, -1);
    };
    const abandon = () => {
      if (released || abandoned) return;
      abandoned = true;
      this.adjustCount(this.abandonedByManual, manual, 1);
      // Once dispose has cleared the hold timers it must not create new ones: the
      // slot is then released by the call settling, which dispose accounts for.
      if (this.state === "closing" || this.state === "closed") return;
      holdTimer = setTimeout(release, this.abandonHoldMs());
      // Unref'd so the hold never keeps the host process alive by itself.
      holdTimer.unref();
      this.abandonHoldTimers.add(holdTimer);
    };
    return { release, abandon };
  }

  /** Adds `delta` to a per-manual count, deleting the entry at zero so no count goes negative. */
  private adjustCount(counts: Map<string, number>, manual: string, delta: 1 | -1): void {
    const next = (counts.get(manual) ?? 0) + delta;
    if (next > 0) counts.set(manual, next);
    else counts.delete(manual);
  }

  private notePolicyBaseline(context: CallContext): void {
    const sessionID = context.sessionID;
    if (this.policyChecked.has(sessionID)) return;
    this.policyChecked.add(sessionID);
    if (this.policyChecked.size > MAX_POLICY_SESSIONS) {
      // Set iteration is insertion order, so the first value is the oldest.
      const oldest = this.policyChecked.values().next().value;
      if (oldest !== undefined) this.policyChecked.delete(oldest);
    }

    const probe = this.hooks.policyBaseline ?? defaultPolicyBaseline;
    let verdict: "rule" | "no-rule" | "unknown";
    try {
      verdict = probe(this.ctx.location?.directory);
    } catch {
      verdict = "unknown";
    }
    if (verdict === "no-rule") {
      this.logger.emit({ event: "policy", notice: "policyBaselineUnverified", sessionID });
    }
  }

  private unknownTool(name: string): FailureResult {
    const failed = this.manuals.filter((status) => !status.success);
    return failure({
      code: "UNKNOWN_TOOL",
      message: `Tool '${displayText(name, 120)}' is not registered by this plugin. Use search to find an exact name.`,
      tool: displayText(name, 120),
      ...(failed.length === 0 ? {} : { manuals: failed }),
    });
  }

  private unavailable(): FailureResult {
    return failure({
      code: "TOOL_UNAVAILABLE",
      message: "The UTCP client is no longer available in this session.",
      retryable: false,
    });
  }
}

// -------------------------------------------------------------------- helpers

function toCallContext(context: ToolExecuteContext): CallContext {
  return {
    sessionID: String(context.sessionID ?? ""),
    agent: context.agent === undefined ? undefined : String(context.agent),
    messageID: context.messageID === undefined ? undefined : String(context.messageID),
    id: context.id === undefined ? undefined : String(context.id),
    signal: context.signal,
    progress: context.progress === undefined ? undefined : (metadata) => context.progress(metadata),
  };
}

/**
 * Resolves `true` when `work` settles first and `false` when the deadline fires.
 * The timer is cleared in every path, so a settled call leaves no timer behind
 * to keep the process alive or fire later. A rejection counts as settled: the
 * caller decides what a failure means.
 */
async function withinDeadline(work: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function describeReceived(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const floored = Math.trunc(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_SEARCH_LIMIT);
}

function manualNameFromTemplate(template: CallTemplate): string {
  const name = typeof template.name === "string" ? template.name.trim() : "";
  if (name.length > 0) return name.replace(/[^\w]/g, "_");
  return "unnamed";
}

/**
 * Reads the session directory's config for a `utcp` permission rule: the first
 * readable of `opencode.jsonc`, `opencode.json`, `config.json`. The file is
 * parsed after comments are removed, and only an object in the top-level
 * `permissions` array with `action: "utcp"` counts (the host ignores the
 * singular `permission` key). Diagnostic only: it cannot see the global
 * config, saved approvals or the merged effective policy, and the adapter never
 * treats the absence of a rule as a decision.
 */
export function defaultPolicyBaseline(directory: string | undefined): "rule" | "no-rule" | "unknown" {
  if (directory === undefined || directory.length === 0) return "unknown";
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"];
  for (const file of candidates) {
    let raw: string;
    try {
      raw = readFileSync(`${directory}/${file}`, "utf8");
    } catch {
      continue;
    }
    // Trailing commas are JSONC-legal but JSON.parse rejects them, so such a
    // file is reported as unparsable (unknown) rather than guessed at.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      return "unknown";
    }
    const permissions = isObject(parsed) ? parsed.permissions : undefined;
    const hasRule =
      Array.isArray(permissions) &&
      permissions.some((entry) => isObject(entry) && entry.action === "utcp");
    return hasRule ? "rule" : "no-rule";
  }
  return "unknown";
}

/**
 * Removes `//` and `/* *\/` comments outside string literals. Hand-written so
 * no dependency is needed. A comment becomes a space (or keeps its newline), so
 * adjacent tokens stay separated. An unterminated string or comment is left in
 * place for JSON.parse to reject.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end += 1;
        end += 1;
      }
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) {
        // Unterminated: keep the rest verbatim, so JSON.parse rejects it and the
        // verdict is "unknown". Dropping it would read a broken file as valid.
        out += text.slice(index);
        break;
      }
      out += " ";
      index = close + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/**
 * `Plugin.define` is the identity function in `@opencode/plugin@2.2.5`
 * (`dist/promise/plugin.js` is `export function define(plugin) { return plugin; }`).
 * Using a local identity keeps the plugin free of that package's runtime graph
 * (effect, opentelemetry, redis, aws-sdk, hono — ~190 MB of a production
 * install) which `define` never touches; `@opencode/plugin` stays a
 * devDependency for types only. If a future host version gives `define`
 * behaviour, import it instead.
 */
function define(plugin: Plugin.Plugin): Plugin.Plugin {
  return plugin;
}

/**
 * A second adapter in one host process is a configuration error (spec §11):
 * the first instance owns the effective tool names and the live client, so a
 * second one is refused with a coded error rather than a bare `Error`.
 */
export class UtcpAlreadyActiveError extends Error {
  readonly code = "CONFIG_INVALID";

  constructor() {
    super(
      "oc2-utcp: a UTCP adapter is already active in this process. Only one instance per process is supported.",
    );
    this.name = "UtcpAlreadyActiveError";
  }
}

/** Creates the plugin object registered with OpenCode. */
export function createUtcpPlugin(hooks: AdapterHooks = {}): Plugin.Plugin {
  if (ACTIVE !== null) {
    throw new UtcpAlreadyActiveError();
  }

  let adapter: UtcpAdapter | null = null;

  return define({
    id: "utcp",
    async setup(ctx) {
      // The factory-time check cannot cover `setup` running twice for the same
      // plugin object: that would overwrite `ACTIVE`, register the three tools
      // a second time and open a second client. The claim is re-checked here,
      // before any state is committed, so the repeated setup fails whole.
      if (ACTIVE !== null) {
        throw new UtcpAlreadyActiveError();
      }
      const next = new UtcpAdapter(ctx, hooks);
      ACTIVE = next;
      adapter = next;
      try {
        await next.start();
      } catch (error) {
        // A failed start owns no resources and must not keep the singleton:
        // otherwise every later plugin in this process is refused for a host
        // whose first setup merely failed.
        if (ACTIVE === next) ACTIVE = null;
        adapter = null;
        throw error;
      }
      // `start()` returns normally after a config or registration failure and
      // leaves the adapter `closed`. Release the claim here too, so that such a
      // setup does not block every later plugin in this process.
      if (next.status().state === "closed") {
        if (ACTIVE === next) ACTIVE = null;
      }
      return async () => {
        await next.dispose();
        if (ACTIVE === next) ACTIVE = null;
        if (adapter === next) adapter = null;
      };
    },
  });
}
