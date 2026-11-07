# Security boundary status (unreleased)

This document describes the adapter-owned bounded-security changes proposed in
this branch. They are not a complete remedy for the UTCP transport or OpenCode
host security risks.

## Enforced by this adapter

- **Admission:** no more than 64 unsettled SDK invocations globally or 32 per
  manual, including manuals without `waitMs`. Capacity is reserved before
  dispatch and released only when the SDK promise settles. A timeout, caller
  abort, or expiry of a `waitMs` hold does not free this hard capacity.
- **Registration:** at most 32 configured manuals before any SDK setup, and at most 512 discovered tools before schema compilation. The latter does not constrain bytes fetched or parsed by the SDK.
- **Pre-clone arguments:** reject arguments larger than 1 MiB of UTF-8 data
  (including object keys), in addition to the existing node and depth limits.
  The limit runs before `structuredClone` and schema worker messaging.
- **Execution errors:** once dispatch has possibly occurred, transport failures are reported with an unknown outcome; a remote side effect cannot be excluded solely from an HTTP or MCP error.
- **Model-facing serialization:** reject rather than silently truncate a JSON
  tool response or metadata projection above 256 KiB. Results that exceed the
  presentation limit return `RESULT_TOO_LARGE`; after a call is dispatched,
  the outcome is marked `unknown` to discourage unsafe retries.

These limits do not imply that all resource use is bounded. In particular,
counts do not cancel requests that have already been sent.

## Not guaranteed by the adapter

- **Pre-parse transport limits:** UTCP may buffer, decompress, and parse large
  manuals or responses before they reach this adapter. The 256 KiB model-facing
  limit does not protect that earlier memory use. Transport-owned limits must
  be independently implemented and measured under Bun for every enabled
  protocol, including error and streaming paths.
- **Network destination binding:** URL validation without enforcement at
  connection time does not prove that the peer IP, redirects, proxy paths, or
  cross-origin credentials conform to an operator-approved destination.
- **Manual integrity:** the adapter does not verify remote manual bytes against
  an operator-approved hash or signature before SDK registration.
- **Informed host approval:** the current OpenCode permission assertion names
  the tool; it does not bind approval to a canonical argument/destination
  snapshot that the host displays and enforces.
- **Process isolation:** enabling MCP stdio can start a child process. No
  adapter-only code proves its inherited environment or filesystem is isolated.

Until those boundaries are enforced, use only trusted manuals and narrowly
scoped credentials in an isolated runtime with independent egress and memory
restrictions. Do not treat a successful adapter test as proof that an enabled
transport is safe against an untrusted server.

## Verification

`bun test test/security-boundaries.test.ts` exercises the adapter-owned
limits and their dispatch/settlement behavior. Full CI additionally checks
type safety, the existing suite, and OpenCode host integration.

The remaining items above require separate version-pinned dependency and
host-level changes, with security-sensitive findings coordinated privately.
