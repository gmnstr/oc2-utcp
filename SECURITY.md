# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (**Security → Report a vulnerability**). Do not open a public issue, and do not include exploit details in a pull request.

A useful report includes the version of the plugin and OpenCode host, the configuration needed to reproduce (manuals and transport classes, with secrets removed), what an attacker gains, and any log lines that show the behaviour. Reports are acknowledged on a best-effort basis; fixes and advisories are coordinated with you before publication.

## Supported versions

| Component | Version |
| --- | --- |
| oc2-utcp | 0.2.0 |
| OpenCode host | 2.2.5 |
| `@utcp/sdk` | 1.2.0 |
| `@utcp/http` | 1.1.14 |
| `@utcp/mcp` | 1.2.0 |
| `ajv` / `ajv-formats` | 8.18.0 / 3.0.1 |

Only the versions above are tested together. Older or newer combinations may work but are not supported, and security fixes are made against the current version.

## Known dependency advisories

`bun audit` reports three advisories against the reviewed dependency tree. Two do not apply to what is published here, and one is fixed only for the MCP response path (the other zod path cannot be fixed without breaking a dependency contract):

| Advisory | Severity | Applies? | Why |
| --- | --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) `zod < 4.6.6` | high | partly: fixed in this release for MCP server-response parsing; still affected for `@utcp/sdk` manual parsing and anything `@utcp/http` bundles (not assessed) | Fixed in this release for MCP server-response parsing: the MCP SDK now resolves zod 4.6.7 (a direct dependency, pinned), while the lockfile keeps `@utcp/sdk` on zod 3.25.76 because the SDK is incompatible with zod 4 (measured 2026-11-06: 40 of 119 tests fail when forced). Enforced by `test/deps-zod.test.ts`. **Still affected:** `@utcp/sdk` manual parsing (zod 3.25.76; no patched zod 3 exists) and anything `@utcp/http` bundles; not assessed. Keep `http` manuals pointed only at trusted endpoints. The MCP response path is patched, so the earlier advice to keep `mcp-http` only for trusted servers is relaxed to this note. |
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
