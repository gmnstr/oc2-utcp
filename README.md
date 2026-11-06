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
| `mcp-http` | enabled | `mcp` manuals using HTTP/SSE servers |
| `local-file` | disabled | `file`, `text` |
| `mcp-stdio` | disabled | `mcp` manuals that spawn a child process |
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
// { matches: [{ name, description, manual, transport, tags }] }

const { tool } = tools.utcp.describe({ name: "github.create_issue" });
// { tool: { name, description, inputSchema, outputSchema, manual, transport, schemaSupported } }

const result = tools.utcp.call({ name: "github.create_issue", arguments: { title: "Bug" } });
// { ok: true, result } | { ok: false, error: { code, message, retryable, ... } }
```

`search` and `describe` return projections only — no manual templates, headers or transport internals. `call` returns the remote result unchanged.

Error codes: `UNKNOWN_TOOL`, `TOOL_NOT_ALLOWED`, `TOOL_UNAVAILABLE`, `INVALID_ARGUMENTS`, `VALIDATION_FAILED`, `SCHEMA_UNSUPPORTED`, `CONFIG_INVALID`, `CONFIGURATION_ERROR`, `TRANSPORT_ERROR`, `TIMEOUT`, `INTERNAL_ERROR`.

## Security

Read this section before enabling the plugin on a repository you do not control.

1. **Configured tools are not automatically approved.** A tool that is configured, allowed and registered can still be called without a human decision unless your host policy says otherwise. Configure a policy; do not rely on the tool list being small.
2. **Registration itself can perform I/O.** Manifests are fetched when the plugin loads. With `mcp-http`, the plugin may connect to the configured server during initialization, before any tool call is approved. With `mcp-stdio`, registration can create a child process. Both classes are on or off per configuration — enable them only for servers you trust, and keep `mcp-stdio` off unless a manifest genuinely requires it.
3. **The UTCP SDK logs on its own.** `@utcp/sdk` and `@utcp/http` write diagnostics to stdout and to stderr independently of this adapter, and they are not filtered here: they can include queries, resolved tool names, post-substitution URLs and failing request bodies. SDK lines therefore interleave with the adapter's `[oc2-utcp]` lines on stderr; the prefix identifies the adapter's own lines. Treat both streams as part of the trust boundary when you capture or forward logs.

A recommended baseline is to require approval for the whole namespace and deny mutating tools by default. Enforcement uses the **`permissions`** array (plural); a rule written under `permission` is dropped by the host with a normalization diagnostic.

```jsonc
{
  "permissions": [
    { "action": "utcp", "resource": "*", "effect": "ask" },
    { "action": "utcp", "resource": "github.delete_*", "effect": "deny" }
  ]
}
```

Only `call` asks for permission. `search` and `describe` do not: the names, short descriptions, tags and full input and output schemas of every tool that passes the configuration filters are visible to the model without approval.

**Denying `execute` is not a kill switch.** On OpenCode 2.2.5, a host `execute` deny rule with resource `*` removes Code Mode, but the host then offers the three tools as direct tools named `utcp_search`, `utcp_describe` and `utcp_call` (see `test/host/permissions.test.ts`, "denying execute promotes the Code Mode tools to direct utcp_* tools"). Those tools still run the same code, and `call` still asks the `utcp` permission action. To disable UTCP calls, add a deny under `permissions`:

```jsonc
{
  "permissions": [
    { "action": "utcp", "resource": "*", "effect": "deny" }
  ]
}
```

This stops `call`, which is the only tool that reaches a transport. The host's enforcement of this deny was not tested. `search` and `describe` still return projections.

The adapter logs `call`, `policy`, `manual` and `lifecycle` events as `[oc2-utcp] {...}` on stderr, including the tool name, manual, transport, duration, outcome and session identifiers — never argument values or headers.

Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Compatibility

- **OpenCode 2.2.5** is the supported host. The model-facing catalog shows the tools as `tools.utcp.search(...)`, `tools.utcp.describe(...)` and `tools.utcp.call(...)`; `ctx.tool.list()` inside the host reports the bare names `search`, `describe`, `call`.
- **JSON Schema subset.** Supported: `type`, `properties`, `required`, `items`, `enum`, `const`, `additionalProperties`, `pattern`, numeric and length bounds, `default`, `title`, `description`, `examples`, `format`. Tools using `$ref`, composition (`oneOf`/`anyOf`/`allOf`/`not`), conditionals, `patternProperties`, `dependencies`, `contains`, `prefixItems`, `uniqueItems`, `multipleOf`, exclusive bounds or `unevaluated*` are still discoverable, but a call fails with `SCHEMA_UNSUPPORTED` rather than being validated loosely.
- **Plain HTTP is refused except to a literal loopback host.** `@utcp/http` accepts `http://` only when the manual's URL names `localhost`, `127.0.0.1` or `::1` itself. Refused: plain HTTP to any other host; a loopback target that a remote manual or spec supplies as a tool or OAuth token URL; a loopback host that tool arguments steer the request to (arguments may change the path, not the host); and a redirect from a non-loopback origin into loopback. Use HTTPS for anything off-machine.
- **MCP schemas are not dereferenced.** `$ref` in an MCP tool schema is preserved and reported as unsupported instead of being resolved, which avoids resolving local or remote references supplied by the server.
- **Only `streamable_http` honours a manual-level `timeout`.** A hung plain-`http` server holds the invocation until the HTTP client's own default of 30 seconds elapses (not tested end to end). MCP servers have their own `timeout`, in seconds, default 30 (see Timeouts).

### Tested versions

| Component | Version | Where it is recorded |
| --- | --- | --- |
| oc2-utcp | 0.1.1 | `package.json` (release version) |
| OpenCode | 2.2.5 | `@opencode/plugin` devDependency |
| Bun | 1.3.14 | `bun --version` on the development machine; `@types/bun` 1.3.14 |
| `@utcp/sdk` | 1.2.0 | `package.json` dependency; installed `node_modules/@utcp/sdk` |
| `@utcp/http` | 1.1.14 | `package.json` dependency; installed `node_modules/@utcp/http` |
| `@utcp/mcp` | 1.2.0 | `package.json` dependency; installed `node_modules/@utcp/mcp` |
| `ajv` | 8.18.0 | `package.json` dependency; installed `node_modules/ajv` |
| `ajv-formats` | 3.0.1 | `package.json` dependency; installed `node_modules/ajv-formats` |
| `zod` | 3.25.76 | installed hoisted copy, not a direct dependency; `@utcp/sdk` requires `^3.23.8` |

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

- **One adapter per process.** A second instance is refused.
- **Cancellation is not propagated.** The SDK call path accepts no abort signal, so a host abort stops the wait but cannot stop the remote call; the result is `INTERNAL_ERROR` with outcome `unknown`, never a clean "cancelled".
- **Two behaviours depend on `@utcp/mcp` internals** — suppressing its built-in single retry of a failed call, and skipping `$ref` dereferencing. If those internals change, the affected manuals are refused at startup rather than degrading silently.
- **Effective policy cannot be read back from the host.** The adapter can only scan the project configuration text for a `utcp` rule, so a globally configured rule may be reported as unknown in its own diagnostics.
- **SDK output is not captured per plugin.** Diagnostics from `@utcp/sdk` and `@utcp/http` reach the process stdout and stderr unfiltered, and SDK lines interleave with the adapter's `[oc2-utcp]` lines on stderr. The prefix identifies the adapter's own lines.
- **Untrusted servers and manuals can exhaust memory.** The MCP SDK validates responses with zod, and the installed zod 3.25.76 has an unpatched high-severity advisory; a very large malformed array from a server can accumulate one issue object per element. `@utcp/sdk` also parses fetched manuals with zod 3 (`UtcpManualSchema`), so `http` manuals are parsed by the affected zod line too. Whether the advisory's pattern is reachable through that path was not assessed. Keep `mcp-http` enabled only for trusted servers, and point `http` manuals only at endpoints you trust. See [SECURITY.md](SECURITY.md#known-dependency-advisories).
- **Unload waits are bounded.** On unload the adapter waits at most about 10 seconds for in-flight calls and then at most about 10 seconds for client close. It then logs a `lifecycle` line with `detail` `inflightAbandoned:<n>` or `closeTimedOut` and proceeds. Abandoned calls are not stopped, and their remote effect is unknown.
- **No live refresh.** Manuals are resolved at startup; changing them means reloading the host.

## Verified host and SDK behaviour

Answers to the open verification items. "Verified" means the code or test named in the evidence was read in this checkout; host integration tests were not executed for this section.

| Item | Answer | Evidence | Status |
| --- | --- | --- | --- |
| 14.1 Multi-resource saved approvals | Not tested. The adapter asserts one resource per call (the tool name) and asks to save it only when the name matches `^[A-Za-z0-9_.\-]+$`. | `src/plugin.ts:735-745` | Not verified |
| 14.2 Effective policy resolution | No API found that returns the merged rule set. The host exposes `ctx.permission.hook("evaluate", ...)`, `list` and `get`, none evaluated here. The adapter only scans project config text for a `utcp` rule. | `node_modules/@opencode/plugin/dist/promise/permission.d.ts:20-21`; `src/plugin.ts:861-876` | Not verified |
| 14.3 Code Mode reachability | Denying `execute` removes Code Mode and exposes `utcp_search`, `utcp_describe` and `utcp_call` as direct tools. See Security. | `test/host/permissions.test.ts:227-268` (host test; read, not executed) | Verified |
| 14.4 Registration-time MCP behaviour | Stdio children are spawned during `start()` and terminated on dispose. `mcp` manuals list tools through a session at registration, which connects to the server. `http` manifests are fetched at registration. | `test/gaps.test.ts:217-247`; `node_modules/@utcp/mcp/dist/index.js:4579-4603`; `node_modules/@utcp/http/dist/index.js:5294-5328` | Verified |
| 14.5 `RegisterManualResult` semantics | Each manual's result is inspected once. A failed manual is recorded as `registered: false` with a fixed reason, is not retried, and does not stop the other manuals from registering. | `src/plugin.ts:307-335` | Verified |
| 14.6 `callToolStreaming` abort | Not verified. Not used: the adapter calls `callTool`, which takes no abort signal. | `node_modules/@utcp/sdk/dist/index.js:1563`; `src/plugin.ts:768-770` | Not verified |
| 14.7 SDK stdout, channels | `@utcp/sdk` and `@utcp/http` write to stdout and to stderr. | `node_modules/@utcp/sdk/dist/index.js:1504-1688`; `node_modules/@utcp/http/dist/index.js:5281-5284` | Verified |
| 14.7 SDK stdout, host capture | Whether OpenCode captures or forwards either stream was not tested. | none | Not verified |
| 14.8 Setup replay in one process | A second `setup` in the same process is refused with `CONFIG_INVALID`. | `test/gaps.test.ts:313-331`; `src/plugin.ts:996-998` | Verified |
| 14.8 Setup replay on host reload | Not tested. | none | Not verified |
| 14.9 `text` transport, classification | `text` is classified as `local-file` and that class is disabled by default. | `src/transport.ts:31`, `:67-68` | Verified |
| 14.9 `text` transport, registration | Whether `@utcp/text` reads files at registration was not tested. | none | Not verified |
| 14.10 Per-plugin stdout capture | Not verified. The adapter neither captures nor redirects SDK stdout. | `src/log.ts:57-64` | Not verified |
| 14.11 Shared repository mutation | Not verified. | none | Not verified |
