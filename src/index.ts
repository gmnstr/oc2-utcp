/**
 * OC2 UTCP plugin — server entry.
 *
 * Loadable as a local plugin directory (no build step): the package `exports`
 * map points `.` at this TypeScript file and the host loads it directly.
 *
 * Nothing here performs I/O. All configuration is read from `ctx.options` and
 * all initialisation happens in `setup`.
 */

import { createUtcpPlugin, UtcpAdapter } from "./plugin.js";

export { createUtcpPlugin, UtcpAdapter } from "./plugin.js";
export type { AdapterHooks } from "./plugin.js";

export default createUtcpPlugin();
