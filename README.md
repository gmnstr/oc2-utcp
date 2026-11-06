# oc2-utcp

A plugin for **OpenCode V2 (OC2)** that connects [UTCP](https://github.com/universal-tool-calling-protocol) manuals to the model through a single Code Mode tool namespace: `tools.utcp.search`, `tools.utcp.describe` and `tools.utcp.call`.

Instead of registering every remote tool as a first-class tool, the plugin exposes three meta-tools and resolves your configured manuals behind them. That keeps the tool catalog stable while the set of available upstream tools changes, and gives one place to enforce configuration, validation and approval.

## Features

- **One namespace, three tools.** `search` finds tools, `describe` returns a schema, `call` executes.
- **Explicit allow-listing.** A tool is only reachable if it is configured, its transport class is enabled, it matches the `tools` patterns and it registered successfully. Everything else is refused before any transport runs.
- **Authoritative argument validation.** Arguments are checked against the schema reported by the remote tool with Ajv (`strict`, no coercion, no defaults, no removing extra properties). Unsupported schema features are reported instead of guessed at.
- **Approval-aware.** Every call asks the host for permission with `action: "utcp"` and the resolved tool name as the resource, so host permission rules and "remember this" work naturally.
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
            "content_type": "application/json",
            "timeout": 10000
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

Disabled classes are refused before manuals are registered, so nothing is spawned, connected or opened for them. Invalid configuration fails closed: no tools are registered and every call returns `CONFIG_INVALID`. A manual whose `call_template_type` is missing or unknown is classified `unclassified` and dropped, while valid manuals keep working.

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
3. **The UTCP SDK logs on its own.** The SDK writes diagnostics to stdout independently of this adapter and they are not filtered here: they can include queries, resolved tool names, post-substitution URLs and failing request bodies. Treat stdout as part of the trust boundary when you capture or forward logs.

A recommended baseline is to require approval for the whole namespace and deny mutating tools by default. Enforcement uses the **`permissions`** array (plural); a rule written under `permission` is dropped by the host with a normalization diagnostic.

```jsonc
{
  "permissions": [
    { "action": "utcp", "resource": "*", "effect": "ask" },
    { "action": "utcp", "resource": "github.delete_*", "effect": "deny" }
  ]
}
```

The adapter logs `call`, `policy`, `manual` and `lifecycle` events as `[oc2-utcp] {...}` on stderr, including the tool name, manual, transport, duration, outcome and session identifiers — never argument values or headers.

Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Compatibility

- **OpenCode 2.2.5** is the supported host. The model-facing catalog shows the tools as `tools.utcp.search(...)`, `tools.utcp.describe(...)` and `tools.utcp.call(...)`; `ctx.tool.list()` inside the host reports the bare names `search`, `describe`, `call`.
- **JSON Schema subset.** Supported: `type`, `properties`, `required`, `items`, `enum`, `const`, `additionalProperties`, `pattern`, numeric and length bounds, `default`, `title`, `description`, `examples`, `format`. Tools using `$ref`, composition (`oneOf`/`anyOf`/`allOf`/`not`), conditionals, `patternProperties`, `dependencies`, `contains`, `prefixItems`, `uniqueItems`, `multipleOf`, exclusive bounds or `unevaluated*` are still discoverable, but a call fails with `SCHEMA_UNSUPPORTED` rather than being validated loosely.
- **Plain HTTP to remote hosts is refused** by `@utcp/http`; loopback targets and redirects to non-loopback hosts are refused too. Use HTTPS for anything off-machine.
- **MCP schemas are not dereferenced.** `$ref` in an MCP tool schema is preserved and reported as unsupported instead of being resolved, which avoids resolving local or remote references supplied by the server.
- **Only `streamable_http` carries a request timeout.** A hung plain-HTTP server holds the invocation until the HTTP client's own default elapses.

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
- **SDK output is not captured per plugin.** Diagnostics from the SDK reach the process stdout unfiltered.
- **Untrusted MCP servers can exhaust memory.** The MCP SDK validates responses with zod, and the installed zod 3.25.76 has an unpatched high-severity advisory; a very large malformed array from a server can accumulate one issue object per element. Keep `mcp-http` enabled only for trusted servers. See [SECURITY.md](SECURITY.md#known-dependency-advisories).
- **No live refresh.** Manuals are resolved at startup; changing them means reloading the host.
