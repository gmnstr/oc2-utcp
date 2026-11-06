# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (**Security → Report a vulnerability**). Do not open a public issue, and do not include exploit details in a pull request.

A useful report includes the version of the plugin and OpenCode host, the configuration needed to reproduce (manuals and transport classes, with secrets removed), what an attacker gains, and any log lines that show the behaviour. Reports are acknowledged on a best-effort basis; fixes and advisories are coordinated with you before publication.

## Supported versions

| Component | Version |
| --- | --- |
| oc2-utcp | 0.1.1 |
| OpenCode host | 2.2.5 |
| `@utcp/sdk` | 1.2.0 |
| `@utcp/http` | 1.1.14 |
| `@utcp/mcp` | 1.2.0 |
| `ajv` / `ajv-formats` | 8.18.0 / 3.0.1 |

Only the versions above are tested together. Older or newer combinations may work but are not supported, and security fixes are made against the current version.

## Known dependency advisories

`bun audit` reports three advisories against the reviewed dependency tree. Two do not apply to what is published here, and one cannot be fixed without breaking a dependency contract:

| Advisory | Severity | Applies? | Why |
| --- | --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) `zod < 4.6.6` | high | yes, for untrusted MCP servers; manual parsing not assessed | The MCP SDK validates server responses with its `zod/v4` schemas, and zod accumulates one issue object per failing array element with no cap. `@utcp/sdk` 1.2.0 requires `zod ^3.23.8`, and zod 3 has no patched release; installing zod 4 breaks the SDK (measured 2026-11-06: 40 of 119 tests fail when the SDK is forced onto zod 4 by `bun add zod@4` plus removal of the SDK's nested zod 3 copy, in a throwaway checkout; with only a top-level zod 4 and the SDK's nested zod 3 kept, 0 tests fail). `@utcp/sdk` also parses fetched manuals with zod 3, so `http` manuals are parsed by the affected line too; whether the advisory's pattern is reachable through that path was not assessed. Keep `mcp-http` enabled only for servers you trust, and point manuals and MCP servers only at endpoints you trust, until upstream relaxes that range. |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) `glob` | moderate | no | Reached only through the `@opencode/plugin` development dependency; absent from a production install. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) `minimatch` | moderate | no | Same development-only path as `glob`. |

`ajv` was updated to 8.18.0, which clears GHSA-2g4f-4pwh-qvx6 for this tree.


## Scope and threat model

The plugin runs inside the OpenCode process and treats everything a UTCP manual or remote server returns as untrusted input: tool names, descriptions, JSON Schemas and call results. It does not execute remote code, and it validates arguments before a transport is used.

Be aware of the following, which are documented behaviour rather than defects:

- Manifests are fetched and MCP servers may be contacted **during plugin initialization**, before any per-call approval.
- `mcp-stdio` manuals can **create a child process** at registration time. The class is disabled by default; enable it only for servers you trust.
- The UTCP SDK and protocol packages (for example `@utcp/http`) write their own diagnostics to **stdout and stderr**, independently of this adapter, and those diagnostics may contain queries, tool names and URLs. SDK lines interleave with the adapter's `[oc2-utcp]` lines on stderr.
- Tool calls are authorized by the host's `utcp` permission action. Configuring a tool does not by itself guarantee a human approval step; set an `ask` policy as described in the README.

Out of scope: vulnerabilities in OpenCode itself, in the UTCP SDK packages, or in remote services the operator chooses to connect to. Report those upstream.

## Handling secrets

Keep credentials out of `manuals` where the schema allows an environment indirection, avoid committing `opencode.jsonc` files that contain tokens, and remember that request URLs may be logged by the SDK. The adapter never logs argument values, headers or templates.
