# oc2-utcp

A plugin for **OpenCode V2 (OC2)** that connects [UTCP](https://github.com/universal-tool-calling-protocol) manuals to the model through a single Code Mode tool namespace: `tools.utcp.search`, `tools.utcp.describe` and `tools.utcp.call`.

Instead of registering every remote tool as a first-class tool, the plugin exposes three meta-tools and resolves your configured manuals behind them. That keeps the tool catalog stable while the set of available upstream tools changes, and gives one place to enforce configuration, validation and approval.

## Features

- **One namespace, three tools.** `search` finds tools, `describe` returns a schema, `call` executes.
- **Explicit allow-listing.** A tool is only reachable if it is configured, its transport class is enabled, it matches the `tools` patterns and it registered successfully. Everything else is refused before any transport runs.
- **Authoritative argument validation.** Arguments are checked against the schema reported by the remote tool with Ajv (`strict`, no coercion, no defaults, no removing extra properties). Unsupported schema features are reported instead of guessed at.
- **Approval-aware.** Every `call` asks the host for permission with `action: "utcp"` and the resolved tool name as the resource, so host permission rules and "remember this" work naturally. `search` and `describe` do not ask (see Security).
- **Transport classes you can switch off.** File, CLI and MCP-stdio access are off by default.
- **Structured logs.** The adapter writes one JSON line per event to stderr; no argument values, headers or templates.
- **No ambient state.** Nothing is read from the process working directory unless you configure it.

## Installation

Requirements: OpenCode **2.2.5** and, to build or run the tests, [Bun](https://bun.sh) 1.3.x. The plugin runs inside the OpenCode process, so no Node.js runtime is involved.

The package is not published to npm — clone it and point your host configuration at the checkout:

```bash
git clone https://github.com/gmnstr/oc2-utcp.git
cd oc2-utcp
bun install
bunx tsc --noEmit   # typecheck
bun test            # unit tests; host integration tests skip if no OpenCode is installed
```

The package entry point is `./src/index.ts`, so a development checkout can be referenced directly. For a self-contained copy, stage `src/`, `package.json` and `bun.lock` and run `bun install --production --frozen-lockfile`.

## Configuration

Add one plugin entry to your project's `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/oc2-utcp",
      "options": {
        "manuals": [
          {
            "name": "github",
            "call_template_type": "http",
            "http_method": "GET",
            "url": "https://raw.githubusercontent.com/owner/repo/main/utcp_manual.json",
            "content_type": "application/json"
          }
        ],
        "tools": ["github.list_*", "github.get_*"],
        "transports": { "mcp-stdio": false, "local-file": false, "cli": false }
      }
    }
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `manuals` | `CallTemplate[]` | required, may be empty | UTCP manuals to load |
| `tools` | `string[]` | `["*"]` | `*`/`?` patterns matched against resolved tool names |
| `transports` | `{ [class]: boolean }` | see below | Enable or disable transport classes; unknown classes are rejected |
| `rootDir` | `string` | host project directory | Base directory for relative manual configuration; required when the host reports no project directory |

| Transport class | Default | Contents |
| --- | --- | --- |
| `http` | enabled | `http`, `sse`, `streamable_http` (the `streamable-http` spelling is accepted too) |
| `mcp-http` | enabled | `mcp` manuals whose server entries all use `transport: "http"`. `@utcp/mcp` accepts only `stdio` and `http` server entries, so there is no SSE server class. A server entry with any other transport makes the manual unclassified. |
| `local-file` | disabled | `file`, `text` |
| `mcp-stdio` | disabled | `mcp` manuals with at least one `transport: "stdio"` server entry, which spawn a child process |
| `cli` | disabled | `cli` |

Disabled classes are refused before manuals are registered, so nothing is spawned, connected or opened for them. Invalid configuration fails closed: no tools are registered. The reason is reported in the adapter's `status()` diagnostics (`error.code` is `CONFIG_INVALID`) and in the lifecycle log line `[oc2-utcp] {"event":"lifecycle","phase":"closed","detail":"CONFIG_INVALID"}`. A manual whose `call_template_type` is missing or unknown is classified `unclassified` and dropped, while valid manuals keep working.

### Timeouts

| Template | Field | Unit | Default |
| --- | --- | --- | --- |
| `http` | none; a `timeout` key is ignored | — | manifest fetch 10 s; tool calls: HTTP client default 30 s (merge not tested) |
| `streamable_http` | `timeout` | milliseconds | 60000 |
| `sse` | none; a `timeout` key is ignored | — | discovery handshake 30 s; bound on tool calls not verified |
| `mcp` server entry (`mcpServers.<name>`) | `timeout` | seconds | 30 |

Only `streamable_http` honours a `timeout` on the manual. An `http` or `sse` manual that sets one gets no effect, and the adapter logs `{"event":"config","notice":"timeoutIgnored","manual":"<name>","template":"http"}` (or `"sse"`) to stderr once for that manual, without the value. Whether the HTTP client's 30 s default applies to plain `http` tool calls, rather than some other merge of the missing value, was not tested.

## Usage

The three tools are Code Mode tools, reached from the host's `execute` surface:

```ts
const { matches } = tools.utcp.search({ query: "issue", limit: 5 });
// { ok: true, matches: [{ name, description, manual, transport, tags }] }

const { tool } = tools.utcp.describe({ name: "github.create_issue" });
// { ok: true, tool: { name, description, manual, transport, tags, inputSchema, outputSchema, schemaSupported, schemaIssues? } }

const result = tools.utcp.call({ name: "github.create_issue", arguments: { title: "Bug" } });
// { ok: true, result } | { ok: false, error: { code, message, retryable, ... } }
```

`schemaIssues` is present only when `schemaSupported` is `false`; each entry is `{ path, keyword, message? }`, where `path` is a dotted path such as `arguments.properties.filter.allOf`.

`search` and `describe` return projections only — no manual templates, headers or transport internals. `call` returns the remote result unchanged.

Error codes: `UNKNOWN_TOOL`, `TOOL_NOT_ALLOWED`, `TOOL_UNAVAILABLE`, `INVALID_ARGUMENTS`, `VALIDATION_FAILED`, `SCHEMA_UNSUPPORTED`, `CONFIG_INVALID`, `CONFIGURATION_ERROR`, `TRANSPORT_ERROR`, `TIMEOUT`, `INTERNAL_ERROR`.

## Security

Read this section before enabling the plugin on a repository you do not control.

1. **Configured tools are not automatically approved.** A tool that is configured, allowed and registered can still be called without a human decision unless your host policy says otherwise. Configure a policy; do not rely on the tool list being small.
2. **Registration itself can perform I/O.** Manifests are fetched when the plugin loads. With `mcp-http`, the plugin may connect to the configured server during initialization, before any tool call is approved. With `mcp-stdio`, registration can create a child process. Both classes are on or off per configuration — enable them only for servers you trust, and keep `mcp-stdio` off unless a manifest genuinely requires it.
3. **The UTCP SDK logs on its own.** `@utcp/sdk` and `@utcp/http` write diagnostics to stdout and to stderr independently of this adapter, and they are not filtered here: they can include queries, resolved tool names, post-substitution URLs and failing request bodies. SDK lines therefore interleave with the adapter's `[oc2-utcp]` lines on stderr; the prefix identifies the adapter's own lines. Treat both streams as part of the trust boundary when you capture or forward logs.

A recommended baseline is to require approval for the whole namespace and deny mutating tools by default. The host reads the plural **`permissions`** array, and the adapter's own policy scan reads that array too. The adapter's scan ignores the singular `permission` key. How the host handles the singular key is not covered by a test in this repository, so do not rely on a rule written under it.

```jsonc
{
  "permissions": [
    { "action": "utcp", "resource": "*", "effect": "ask" },
    { "action": "utcp", "resource": "github.delete_*", "effect": "deny" }
  ]
}
```

Only `call` asks for permission. `search` and `describe` do not: the names, short descriptions, tags and full input and output schemas of every tool that passes the configuration filters are visible to the model without approval.

**Denying `execute` is not a kill switch.** On OpenCode 2.2.5, a host `execute` deny rule with resource `*` removes Code Mode, but the host then offers the three tools as direct tools named `utcp_search`, `utcp_describe` and `utcp_call` (see `test/host/permissions.test.ts`, "denying execute promotes the Code Mode tools to direct utcp_* tools"). Those tools run the same code, so by code path `call` still asks the `utcp` permission action. No host test calls a promoted tool under an `execute` deny; that test checks only the tool names, so the permission behaviour of the promoted tools is not verified.

The documented mechanism for an unbypassable operator limit is `policies`: they are evaluated after rules and saved approvals, turn `allow` or `ask` into `deny`, and never grant access (spec section 6.3). This repository does not test a `policies` configuration. The spec's example is `{ "action": "tool.use", "resource": "utcp:*", "effect": "deny" }`, which is not verified here. To disable UTCP calls through the `permissions` array, add a deny:

```jsonc
{
  "permissions": [
    { "action": "utcp", "resource": "*", "effect": "deny" }
  ]
}
```

This stops `call`, which is the only tool that reaches a transport. Host tests do enforce `utcp` deny rules on named resources: `test/host/permissions.test.ts` denies `demo.echo` and `demo.delete_item` and checks that each call is refused with no dispatch. Those suites skip without an OpenCode executable. A wildcard `*` deny of the `utcp` action is not tested. `search` and `describe` still return projections.

The adapter logs `call`, `policy`, `manual`, `lifecycle` and `config` events as `[oc2-utcp] {...}` on stderr, including the tool name, manual, transport, duration, outcome and session identifiers — never argument values or headers. The `config` event is `timeoutIgnored`, emitted once per `http` or `sse` manual that sets a `timeout`; the value is not logged.

Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Compatibility

- **OpenCode 2.2.5** is the supported host. The model-facing catalog shows the tools as `tools.utcp.search(...)`, `tools.utcp.describe(...)` and `tools.utcp.call(...)`; `ctx.tool.list()` inside the host reports the bare names `search`, `describe`, `call`.
- **Effective tool names differ from the spec.** Spec section 3.1 and the acceptance criterion in section 11 expect the effective names `utcp_search`, `utcp_describe` and `utcp_call`. This build does not produce them in the Code Mode catalog (they appear only when a host `execute` deny promotes the tools, as described under Security). The shipped `tools.utcp.search`, `tools.utcp.describe` and `tools.utcp.call` form is a deliberate, operator-approved exception. The measured reasons are recorded above the `transform` registration in `src/plugin.ts` (`UtcpAdapter.registerTools`) and in `test/host/probe-forms.ts`: a `utcp` namespace with bare names gives `tools.utcp.*`; a namespace with prefixed names gives `utcp_*` in `ctx.tool.list()` but doubles the prefix in the model catalog (`tools.utcp.utcp_search(...)`); no namespace with prefixed names gives `tools.utcp_search(...)`.
- **JSON Schema subset (fail closed).** A keyword outside the supported set is rejected, not ignored. Supported: `type`, `properties`, `required`, `items` (single-schema form only), `enum`, `const`, `additionalProperties`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`, `default`, `title`, `description`, `examples`, `format` (only formats Ajv knows), `$schema` (accepted only as the draft-07 URI `http://json-schema.org/draft-07/schema`, with or without a trailing `#`; `https://` is refused under the `$schema` keyword, because Ajv's draft-07 class registers only the `http://` metaschema), `anyOf`, `oneOf` (non-empty arrays), `multipleOf`, `exclusiveMinimum`, `exclusiveMaximum` (numeric draft-07 form), and local references (non-recursive; see below). A local reference is `$ref` with the value `#/$defs/<name>` or `#/definitions/<name>`, naming a member of the root schema's `$defs` or `definitions` (member names match `[A-Za-z0-9_-]{1,64}`). A `$ref` may sit beside only `title`, `description`, `examples` and `default`, and `$defs` and `definitions` are accepted only at the root. Rejected by name: `allOf`, `not`, `if`, `then`, `else`, `propertyNames`, `dependencies`, `dependentRequired`, `dependentSchemas`, `contains`, `minContains`, `maxContains`, `prefixItems`, `unevaluatedProperties`, `unevaluatedItems`, `uniqueItems` (quadratic in array length when items are not scalars; deferred), `patternProperties` (matches model-chosen property names against schema regexes; deferred), every other `$ref` form (external, absolute, relative-file, nested pointer, or a missing target), and the tuple form of `items`. Recursive `$ref` is also rejected in 0.2.0: a reference that reaches a definition already being resolved, with or without a property in between, fails with keyword `$ref` and the message `recursive reference is not supported`. Also rejected, because they are outside the supported set: `minItems`, `maxItems`, `minProperties`, `maxProperties`, `$id`, and any other unlisted keyword. Tools using a rejected keyword are still discoverable and describable, but a call fails with `SCHEMA_UNSUPPORTED` rather than being validated loosely.
- **Plain HTTP is refused except to a literal loopback host.** `@utcp/http` accepts `http://` only when the manual's URL names `localhost`, `127.0.0.1` or `::1` itself. Refused: plain HTTP to any other host; a loopback target that a remote manual or spec supplies as a tool or OAuth token URL; a loopback host that tool arguments steer the request to (arguments may change the path, not the host); and a redirect from a non-loopback origin into loopback. Use HTTPS for anything off-machine.
- **MCP schemas are not dereferenced.** The adapter does not resolve `$ref` in MCP tool schemas during registration. A local reference is validated by the adapter itself; any other reference is reported as unsupported (keyword `$ref`) and never resolved, so no file or network read happens on a remote server's behalf.

**Schema limits.** The walk and its bounds run once, at readiness, before Ajv sees a schema. A schema is refused when it has more than `MAX_SCHEMA_NODES` (10,000) literal schema objects (a definition reached by several `$ref`s is counted once), when a `$ref` chain nests more than `MAX_REF_DEPTH` (64) targets deep, when a `required` or `enum` array has more than 1,000 entries, or when its evaluation bound exceeds `MAX_EVAL_PATHS` (16,384). The bound counts every validation path one instance can take: each `anyOf`/`oneOf` branch and each `$ref` re-checks the same instance, so n levels that each reference the previous one through two branches cost 2^n paths. Recursive references are refused, so the count is exact and the memoized sum cannot hide fan-out inside recursion. A node's own weight is 1 plus its `required` and `enum` entries, because Ajv inlines leaf `$ref` targets at every reference site and each entry costs work; the bound counts those entries too, so a 600-name `required` list in a definition referenced from 40 properties is refused. The bound is computed statically, so a refused schema is never compiled.

Measurements, from GitHub Actions runs:

- Run `42287887386`: at n = 22, validate took 2,898 ms; compiling the flat form took about 60 ms; with `inlineRefs: false`, validate took 2,975 ms.
- Run `42289850304`: at n = 22, `allErrors: true` took 1,709 ms against 1,586 ms with `allErrors: false`; at n = 26 the run exceeded a 40 s cap.

`MAX_SCHEMA_NODES`, `MAX_REF_DEPTH`, `MAX_ARG_DEPTH` and `MAX_EVAL_PATHS` are chosen limits, not measured thresholds. `MAX_EVAL_WORK` (500,000) is derived from a measured cost of about 0.7 microseconds per validation path, so one call's worst allowed validator work is about 0.35 s of synchronous CPU.

Arguments have their own work limit. A call's work is the schema's bound times its argument node count, and above `MAX_EVAL_WORK` the arguments are refused before Ajv runs with `arguments are too large for this tool's schema.` A schema that is cheap for one value can be expensive for a long array: a bound of 8,193 with 2,000 items is about 16 million paths, far above the limit. Arguments are also refused before Ajv when they nest deeper than `MAX_ARG_DEPTH` (64), or hold more than `MAX_ARG_NODES` (100,000) values (`arguments contain too many values.`), and a refused argument set is never dispatched. The constants are exported from `src/schema.ts`.
- **Only `streamable_http` honours a manual-level `timeout`.** A hung plain-`http` server holds the invocation until the HTTP client's own default of 30 seconds elapses (not tested end to end). MCP servers have their own `timeout`, in seconds, default 30 (see Timeouts).

### Tested versions

| Component | Version | Where it is recorded |
| --- | --- | --- |
| oc2-utcp | 0.2.0 | `package.json` (release version) |
| OpenCode | 2.2.5 | `@opencode/plugin` devDependency |
| Bun | 1.3.14 | `bun --version` on the development machine; `@types/bun` 1.3.14 |
| `@utcp/sdk` | 1.2.0 | `package.json` dependency; installed `node_modules/@utcp/sdk` |
| `@utcp/http` | 1.1.14 | `package.json` dependency; installed `node_modules/@utcp/http` |
| `@utcp/mcp` | 1.2.0 | `package.json` dependency; installed `node_modules/@utcp/mcp` |
| `ajv` | 8.18.0 | `package.json` dependency; installed `node_modules/ajv` |
| `ajv-formats` | 3.0.1 | `package.json` dependency; installed `node_modules/ajv-formats` |
| `zod` | 4.6.7 (direct dependency; used by the MCP SDK) and 3.25.76 (nested under `@utcp/sdk`, which requires `^3.23.8`) | nested resolution kept in `bun.lock` and asserted by `test/deps-zod.test.ts` |

`zod` is a direct dependency that no source file imports. It exists to pin the MCP SDK's hoisted zod to 4.6.7, the patched release for GHSA-mrhx-c7xc-m3w5. `@utcp/sdk` keeps its own nested zod 3.25.76. `test/deps-zod.test.ts` enforces this split and fails on any zod copy that has not been reviewed.

## Development

```bash
bun install
bunx tsc --noEmit                                  # typecheck
bun test                                           # everything; host suites skip without OpenCode
bun test test/host-bin.test.ts                     # host discovery unit tests, no install needed
OC2_OPENCODE_BIN=$(command -v opencode) bun test test/host
OC2_REQUIRE_HOST=1 bun test test/host             # fail instead of skip (CI uses this)
bun test/host/probe-forms.ts                       # registration-form probe (needs a host)
```

Host integration tests need a real OpenCode 2.2.5 executable. They find one from `OC2_OPENCODE_BIN`, then `PATH`, then `node_modules/.bin`, then the usual install locations, and validate it with `--version`. If none is found the suites **skip** with an explanation of what was tried; `OC2_REQUIRE_HOST=1` turns that into a failure so CI cannot pass without exercising the host.

Layout: `src/` is the plugin (`plugin.ts`, `config.ts`, `schema.ts`, `errors.ts`, `transport.ts`, `log.ts`, plus the MCP no-retry shim), `test/` holds unit tests against a fake host, `test/fixtures/` the fixture servers, and `test/host/` the real-host harness (`host-bin.ts` discovery, `sandbox.ts` mock provider, `stage.ts` staged install).

## Limitations

- **`pattern` can freeze the host on a catastrophic regex.** `pattern` (supported since 0.1.0) is evaluated by a backtracking regex engine, synchronously on the host event loop, against model-supplied strings, before permission and dispatch. A manual that advertises a catastrophic pattern such as `^(a+)+$` can freeze the host process with a short input. This is unchanged from 0.1.x and this release has no mitigation for it. Enable only manuals you trust. It is also why `patternProperties` is still rejected: it would apply the same kind of regex to model-chosen property names.
- **One adapter per process.** A second instance is refused.
- **Cancellation is not propagated.** The SDK call path accepts no abort signal, so a host abort stops the wait but cannot stop the remote call; the result is `INTERNAL_ERROR` with outcome `unknown`, never a clean "cancelled".
- **Two behaviours depend on `@utcp/mcp` internals** — suppressing its built-in single retry of a failed call, and skipping `$ref` dereferencing. At startup the adapter checks only that the helper names it overrides exist and that the base `callTool` source mentions `_withSession` (`checkProtocolSurface` in `src/mcp-no-retry.ts`). If those checks fail, the MCP manuals are refused. A behavioural change that keeps the names is not detected at startup. It is caught only by `test/mcp-retry.test.ts` and by the scheduled `.github/workflows/sdk-drift.yml` workflow, which runs weekly against the latest `@utcp/*` packages.
- **Effective policy cannot be read back from the host.** The adapter can only scan the project configuration text for a `utcp` rule, so a globally configured rule may be reported as unknown in its own diagnostics.
- **SDK output is not captured per plugin.** Diagnostics from `@utcp/sdk` and `@utcp/http` reach the process stdout and stderr unfiltered, and SDK lines interleave with the adapter's `[oc2-utcp]` lines on stderr. The prefix identifies the adapter's own lines.
- **Untrusted manuals can still exhaust memory through the zod 3 path.** The MCP SDK validates server responses with zod 4.6.7, which is past the advisory's fix (GHSA-mrhx-c7xc-m3w5, `zod < 4.6.6`); `test/deps-zod.test.ts` asserts that. `@utcp/sdk` cannot move to zod 4 (it keeps zod 3.25.76, which has no patched release) and parses fetched manuals with it (`UtcpManualSchema`), so `http` manuals are parsed by the affected zod line. Whether the advisory's pattern is reachable through that path was not assessed, and anything `@utcp/http` bundles was not assessed either. Point `http` manuals only at endpoints you trust. See [SECURITY.md](SECURITY.md#known-dependency-advisories).
- **Unload waits are bounded.** Each dispose stage waits at most about 10 seconds: in-flight calls, registration disposal, manual deregistration and client close. When a stage expires, the adapter logs a `lifecycle` line whose `detail` is `inflightAbandoned:<n>`, `registrationDisposeTimedOut`, `deregisterTimedOut` or `closeTimedOut`, and continues. Abandoned in-flight calls are not stopped, because the SDK takes no cancellation signal; their remote effect is unknown. A call that is waiting on a permission prompt when the adapter is closing refuses to dispatch and returns `TOOL_UNAVAILABLE`.
- **No live refresh.** Manuals are resolved at startup; changing them means reloading the host.

## Verified host and SDK behaviour

Answers to the open verification items. "Verified" means the code or test named in the evidence was read in this checkout; host integration tests were not executed for this section.

| Item | Answer | Evidence | Status |
| --- | --- | --- | --- |
| 14.1 Multi-resource saved approvals | Not tested. The adapter asserts one resource per call (the tool name) and asks to save it only when the name matches `^[A-Za-z0-9_.\-]+$`. | `UtcpAdapter.assertPermission` in `src/plugin.ts` | Not verified |
| 14.2 Effective policy resolution | No API found that returns the merged rule set. The host exposes `ctx.permission.hook("evaluate", ...)`, `list` and `get`, none evaluated here. The adapter only scans project config text for a `utcp` rule. | `node_modules/@opencode/plugin/dist/promise/permission.d.ts:20-21`; `defaultPolicyBaseline` and `UtcpAdapter.notePolicyBaseline` in `src/plugin.ts` | Not verified |
| 14.3 Code Mode reachability | Denying `execute` removes Code Mode and exposes `utcp_search`, `utcp_describe` and `utcp_call` as direct tools. See Security. | `test/host/permissions.test.ts`, "denying execute promotes the Code Mode tools to direct utcp_* tools" (lines 227-268; read, not executed) | Verified |
| 14.4 Registration-time MCP behaviour | Stdio children are spawned during `start()` and terminated on dispose. `mcp` manuals list tools through a session at registration, which connects to the server. `http` manifests are fetched at registration. | `test/gaps.test.ts`, "an enabled mcp-stdio manual spawns one child and terminates it on dispose" (lines 219-247); `node_modules/@utcp/mcp/dist/index.js:4579-4603`; `node_modules/@utcp/http/dist/index.js:5294-5328` | Verified |
| 14.5 `RegisterManualResult` semantics | Each manual's result is inspected once. A failed manual is recorded as `registered: false` with a fixed reason, is not retried, and does not stop the other manuals from registering. | `UtcpAdapter.initialize` in `src/plugin.ts` (the manual result loop) | Verified |
| 14.6 `callToolStreaming` abort | Not verified. Not used: the adapter calls `callTool`, which takes no abort signal. | `node_modules/@utcp/sdk/dist/index.js:1563` (`callTool`) and `:1599` (`callToolStreaming`); `UtcpAdapter.invoke` in `src/plugin.ts` | Not verified |
| 14.7 SDK stdout, channels | `@utcp/sdk` and `@utcp/http` write to stdout and to stderr. | `node_modules/@utcp/sdk/dist/index.js:1504-1688`; `node_modules/@utcp/http/dist/index.js:5281-5284` | Verified |
| 14.7 SDK stdout, host capture | Whether OpenCode captures or forwards either stream was not tested. | none | Not verified |
| 14.8 Setup replay in one process | A second `setup` in the same process is refused with `CONFIG_INVALID`. | `test/gaps.test.ts`, "a second setup fails with CONFIG_INVALID and a clear message" and "the same plugin object cannot be set up twice" (the latter exercises the re-check in `createUtcpPlugin`'s `setup`) | Verified |
| 14.8 Setup replay on host reload | Not tested. | none | Not verified |
| 14.9 `text` transport, classification | `text` is classified as `local-file` and that class is disabled by default. | `src/transport.ts`: `classForType` (the `text` case) and `DEFAULT_TRANSPORTS` (`local-file: false`) | Verified |
| 14.9 `text` transport, registration | Whether `@utcp/text` reads files at registration was not tested. | none | Not verified |
| 14.10 Per-plugin stdout capture | Not verified. The adapter neither captures nor redirects SDK stdout. | `defaultSink` in `src/log.ts` (writes only to `console.error`) | Not verified |
| 14.11 Shared repository mutation | Not verified. | none | Not verified |
